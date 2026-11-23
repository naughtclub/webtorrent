import WebTorrent from 'webtorrent'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const magnetUri = process.argv[2]
const pointsArg = process.argv[3] || '20,40,60,80'

if (!magnetUri || !magnetUri.startsWith('magnet:')) {
  console.error('Usage: node method1_stream.mjs "<magnet_uri>" [percent_list]')
  process.exit(1)
}

const samplePercents = pointsArg
  .split(',')
  .map((s) => parseFloat(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0 && n < 100)
  .map((n) => n / 100)

if (samplePercents.length === 0) {
  console.error('Provide valid percentages between 1 and 99 (e.g., 20,40,60,80)')
  process.exit(1)
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}

function runCmdCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => (stdout += d.toString()))
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim()}`))
    })
  })
}

async function probeVideo(streamUrl) {
  const out = await runCmdCapture('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    streamUrl,
  ])
  const data = JSON.parse(out)
  const duration = parseFloat(data.format?.duration)
  const stream = data.streams?.[0] || {}
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine video duration: ${out}`)
  }
  return { duration, width: stream.width, height: stream.height }
}

function startChunkedServer(file, chunkSize = 512 * 1024) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (req.url !== '/video') {
        res.writeHead(404)
        return res.end()
      }

      const total = file.length
      let start = 0
      let end = total - 1
      let status = 200
      const headers = {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      }

      const range = req.headers.range
      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range)
        if (match) {
          start = match[1] ? parseInt(match[1], 10) : 0
          end = match[2] ? parseInt(match[2], 10) : total - 1
          if (start >= total || start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` })
            return res.end()
          }
          status = 206
          headers['Content-Range'] = `bytes ${start}-${end}/${total}`
        }
      }

      headers['Content-Length'] = end - start + 1
      res.writeHead(status, headers)

      if (req.method === 'HEAD') return res.end()

      let closed = false
      let activeStream = null
      res.on('close', () => {
        if (!res.writableEnded) {
          closed = true
          if (activeStream) activeStream.destroy()
        }
      })

      try {
        // Pull only 512 KB at a time so WebTorrent never buffers the entire file
        for (let pos = start; pos <= end && !closed; pos += chunkSize) {
          const chunkEnd = Math.min(pos + chunkSize - 1, end)
          activeStream = file.createReadStream({ start: pos, end: chunkEnd })

          for await (const buf of activeStream) {
            if (closed) break
            if (!res.write(buf)) {
              await new Promise((r) => {
                const done = () => {
                  res.off('drain', done)
                  res.off('close', done)
                  r()
                }
                res.once('drain', done)
                res.once('close', done)
              })
            }
          }
          activeStream = null
        }
      } catch (err) {
        if (!closed) console.warn('Stream chunk interrupted:', err.message)
      } finally {
        if (!res.writableEnded) res.end()
      }
    })

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}/video` })
    })
  })
}

const startTime = Date.now()
const client = new WebTorrent()

client.on('error', (err) => {
  console.error('Client error:', err.message)
  process.exit(1)
})

console.log('Fetching magnet metadata...')
client.add(
  magnetUri,
  { deselect: true, destroyStoreOnDestroy: true },
  async (torrent) => {
    torrent.deselect(0, torrent.pieces.length - 1, false)
    torrent.files.forEach((f) => f.deselect())

    const videoExts = ['.mp4', '.mkv', '.webm', '.mov', '.avi']
    const file = torrent.files
      .filter((f) => videoExts.some((ext) => f.name.toLowerCase().endsWith(ext)))
      .sort((a, b) => b.length - a.length)[0]

    if (!file) {
      console.error('No video file found in magnet.')
      client.destroy(() => process.exit(1))
      return
    }

    // Wipe output/ so old files are completely replaced
    const outDir = path.resolve('output')
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.mkdirSync(outDir, { recursive: true })

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-clips-'))
    const thumbPath = path.join(outDir, 'thumbnail.jpg')
    const previewPath = path.join(outDir, 'preview.mp4')

    const { server, url: streamUrl } = await startChunkedServer(file)

    try {
      const { duration, width, height } = await probeVideo(streamUrl)
      console.log(
        `Target: ${file.name} (${(file.length / 1e6).toFixed(2)} MB | ${width}x${height} | ${duration.toFixed(1)}s)`
      )

      const clipPaths = []

      for (let i = 0; i < samplePercents.length; i++) {
        const pct = samplePercents[i]
        const ts = Math.max(0, Math.min(duration - 1.1, duration * pct)).toFixed(2)
        const clipPath = path.join(tmpDir, `clip_${i}.mp4`)
        clipPaths.push(clipPath)

        console.log(`Capturing 1s clip at ${Math.round(pct * 100)}% (${ts}s)...`)

        const args = ['-y', '-ss', ts, '-i', streamUrl]

        // Grab full-resolution thumbnail from the first sample point (20%) with zero extra download
        if (i === 0) {
          args.push('-frames:v', '1', '-q:v', '2', thumbPath)
        }

        // Grab 1-second full-resolution clip (pad ensures even dimensions for libx264 without scaling)
        args.push(
          '-t', '1',
          '-an',
          '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-bf', '0',
          '-video_track_timescale', '90000',
          clipPath
        )

        await runCmd('ffmpeg', args)
      }

      // Merge all 1-second clips into a single full-resolution preview
      const concatListPath = path.join(tmpDir, 'concat.txt')
      const concatContent = clipPaths
        .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
        .join('\n')
      fs.writeFileSync(concatListPath, concatContent)

      console.log(`Merging ${clipPaths.length} clips into output/preview.mp4...`)
      await runCmd('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        previewPath,
      ])

      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1)
      const downloadedMB = (torrent.downloaded / 1e6).toFixed(2)
      const totalMB = (file.length / 1e6).toFixed(2)
      const pct = ((torrent.downloaded / file.length) * 100).toFixed(2)

      console.log('\n--- METHOD 1 (MULTI-POINT FULL-RES) RESULTS ---')
      console.log(`Resolution:   ${width}x${height} (native)`)
      console.log(`Elapsed time: ${elapsedSec}s`)
      console.log(`Downloaded:   ${downloadedMB} MB / ${totalMB} MB (${pct}%)`)
      console.log(`Saved files:  output/thumbnail.jpg, output/preview.mp4`)
    } catch (err) {
      console.error('Failed:', err.message)
      process.exitCode = 1
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      server.close()
      client.destroy(() => process.exit(process.exitCode || 0))
    }
  }
)
