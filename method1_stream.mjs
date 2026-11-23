import WebTorrent from 'webtorrent'
import { execFileSync } from 'node:child_process'

const torrentId = process.argv[2]
if (!torrentId) {
  console.error('Usage: node method1_stream.mjs <magnet_or_torrent_url>')
  process.exit(1)
}

const startTime = Date.now()
const client = new WebTorrent()
const instance = client.createServer()

await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve))
const { port } = instance.server.address()

client.on('error', (err) => {
  console.error('Client error:', err.message)
  process.exit(1)
})

console.log('Adding torrent and fetching metadata...')
client.add(torrentId, { destroyStoreOnDestroy: true }, (torrent) => {
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

  const streamUrl = `http://127.0.0.1:${port}${file.streamURL}`
  console.log(`Target file: ${file.name} (${(file.length / 1e6).toFixed(2)} MB)`)
  console.log(`Streaming via: ${streamUrl}`)

  try {
    // Placing -ss BEFORE -i forces ffmpeg to jump straight to 01:00 via HTTP Range requests
    console.log('Extracting thumbnail at 00:01:00...')
    execFileSync('ffmpeg', [
      '-y', '-ss', '00:01:00', '-i', streamUrl,
      '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '2',
      'm1_thumbnail.jpg'
    ], { stdio: 'inherit' })

    console.log('Extracting 5-second preview clip...')
    execFileSync('ffmpeg', [
      '-y', '-ss', '00:01:00', '-i', streamUrl,
      '-t', '5', '-an', '-vf', 'scale=480:-2',
      '-c:v', 'libx264', '-crf', '28', '-movflags', '+faststart',
      'm1_preview.mp4'
    ], { stdio: 'inherit' })

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1)
    const downloadedMB = (torrent.downloaded / 1e6).toFixed(2)
    const totalMB = (file.length / 1e6).toFixed(2)
    const pct = ((torrent.downloaded / file.length) * 100).toFixed(2)

    console.log('\n--- METHOD 1 RESULTS ---')
    console.log(`Elapsed time: ${elapsedSec}s`)
    console.log(`Downloaded:   ${downloadedMB} MB / ${totalMB} MB (${pct}%)`)
  } finally {
    instance.close()
    client.destroy(() => process.exit(0))
  }
})
