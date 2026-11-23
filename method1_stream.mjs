import WebTorrent from 'webtorrent'
import { spawn } from 'node:child_process'

const torrentArg = process.argv[2]
if (!torrentArg) {
  console.error('Usage: node method1_stream.mjs <magnet_or_torrent_url>')
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

async function resolveTorrentInput(source) {
  if (!source.startsWith('http://') && !source.startsWith('https://')) {
    return source
  }
  console.log(`Downloading .torrent file from ${source}...`)
  const res = await fetch(source, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching torrent file`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  // Valid .torrent files are bencoded dictionaries starting with 'd' (0x64)
  if (buf.length === 0 || buf[0] !== 0x64) {
    const preview = buf.subarray(0, 120).toString('utf8').replace(/\s+/g, ' ')
    throw new Error(`URL did not return a valid .torrent file. First bytes: ${preview}`)
  }
  return buf
}

const startTime = Date.now()
const torrentInput = await resolveTorrentInput(torrentArg)

const client = new WebTorrent()
const instance = client.createServer()
const httpServer = instance.server || instance

await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const { port } = httpServer.address()

client.on('error', (err) => {
  console.error('Client error:', err.message)
  process.exit(1)
})

console.log('Adding torrent and fetching metadata...')
client.add(torrentInput, { destroyStoreOnDestroy: true }, async (torrent) => {
  torrent.on('error', (err) => {
    console.error('Torrent error:', err.message)
    process.exit(1)
  })

  // Stop WebTorrent from downloading the full torrent in the background
  torrent.deselect(0, torrent.pieces.length - 1, false)
  torrent.files.forEach((f) => f.deselect())

  const videoExts = ['.mp4', '.mkv', '.webm', '.mov', '.avi']
  const file = torrent.files
    .filter((f) => videoExts.some((ext) => f.name.toLowerCase().endsWith(ext)))
    .sort((a, b) => b.length - a.length)[0]

  if (!file) {
    console.error('No video file found in torrent.')
    process.exit(1)
  }

  const streamPath =
    file.streamURL ||
    `/webtorrent/${torrent.infoHash}/${file.path.split('/').map(encodeURIComponent).join('/')}`
  const streamUrl = `http://127.0.0.1:${port}${streamPath}`

  console.log(`Target file: ${file.name} (${(file.length / 1e6).toFixed(2)} MB)`)
  console.log(`Streaming via: ${streamUrl}`)

  try {
    console.log('Extracting thumbnail at 00:01:00...')
    await runFfmpeg([
      '-y', '-ss', '00:01:00', '-i', streamUrl,
      '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '2',
      'm1_thumbnail.jpg'
    ])

    console.log('Extracting 5-second preview clip...')
    await runFfmpeg([
      '-y', '-ss', '00:01:00', '-i', streamUrl,
      '-t', '5', '-an', '-vf', 'scale=480:-2',
      '-c:v', 'libx264', '-crf', '28', '-movflags', '+faststart',
      'm1_preview.mp4'
    ])

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1)
    const downloadedMB = (torrent.downloaded / 1e6).toFixed(2)
    const totalMB = (file.length / 1e6).toFixed(2)
    const pct = ((torrent.downloaded / file.length) * 100).toFixed(2)

    console.log('\n--- METHOD 1 RESULTS ---')
    console.log(`Elapsed time: ${elapsedSec}s`)
    console.log(`Downloaded:   ${downloadedMB} MB / ${totalMB} MB (${pct}%)`)
  } catch (err) {
    console.error('FFmpeg failed:', err.message)
    process.exitCode = 1
  } finally {
    instance.close()
    client.destroy(() => process.exit(process.exitCode || 0))
  }
})
