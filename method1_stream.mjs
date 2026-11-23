import WebTorrent from 'webtorrent'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const magnetUri = process.argv[2]
const seekTime = process.argv[3] || '00:00:30'

if (!magnetUri || !magnetUri.startsWith('magnet:')) {
  console.error('Usage: node method1_stream.mjs "<magnet_uri>" [seek_time]')
  process.exit(1)
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with code ${code}`))
    })
  })
}

function startChunkedServer(file, chunkSize = 1024 * 1024) {
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
      const onClose = () => {
        closed = true
        if (activeStream) activeStream.destroy()
      }
      req.on('close', onClose)
      res.on('close', onClose)

      try {
        // Only request 1 MB at a time from WebTorrent so it never buffers the full file
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
    // Extra safeguard to ensure zero background pieces are queued
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

    const safeName = path
      .parse(file.name)
      .name.replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 40)
    const outDir = path.join('previews', `${safeName}-${torrent.infoHash.slice(0, 8)}`)
    fs.mkdirSync(outDir, { recursive: true })

    const thumbPath = path.join(outDir, 'thumbnail.jpg')
    const previewPath = path.join(outDir, 'preview.mp4')

    const { server, url: streamUrl } = await startChunkedServer(file)
    console.log(`Target: ${file.name} (${(file.length / 1e6).toFixed(2)} MB)`)
    console.log(`Output: ${outDir}/`)

    try {
      // Single FFmpeg pass outputs both thumbnail and 5-second preview clip
      await runFfmpeg([
        '-y',
        '-ss', seekTime,
        '-i', streamUrl,
        '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '2',
        thumbPath,
        '-t', '5', '-an', '-vf', 'scale=480:-2',
        '-c:v', 'libx264', '-crf', '28', '-movflags', '+faststart',
        previewPath,
      ])

      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1)
      const downloadedMB = (torrent.downloaded / 1e6).toFixed(2)
      const totalMB = (file.length / 1e6).toFixed(2)
      const pct = ((torrent.downloaded / file.length) * 100).toFixed(2)

      console.log('\n--- METHOD 1 (CHUNKED) RESULTS ---')
      console.log(`Elapsed time: ${elapsedSec}s`)
      console.log(`Downloaded:   ${downloadedMB} MB / ${totalMB} MB (${pct}%)`)
      console.log(`Saved files:  ${thumbPath}, ${previewPath}`)
    } catch (err) {
      console.error('FFmpeg failed:', err.message)
      process.exitCode = 1
    } finally {
      server.close()
      client.destroy(() => process.exit(process.exitCode || 0))
    }
  }
)
