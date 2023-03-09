const readline = require('readline');
const axios = require('axios');
const ProgressBar = require("progress");
const fs = require("fs");
const Path = require("path");
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config();

const episodeRegex = /^https:\/\/www.bilibili.tv\/vi\/play\/[0-9]+\/([0-9]+)/;

axios.defaults.headers = {
  referer: ' https://www.bilibili.tv/', cookie: process.env.COOKIE
}

function formatTime(seconds) {
  return new Date(seconds * 1000).toISOString().slice(11, 23)
}

function convert2srt() {
  let rows = fs.readFileSync(Path.resolve(__dirname, 'temp', 'subtitle.json'), 'utf8');
  rows = JSON.parse(rows).body;
  rows.forEach((row, i) => {
    const formatted = `${i + 1}\r\n${formatTime(row.from)} --> ${formatTime(row.to)}\r\n${row.content}\r\n`
    fs.appendFileSync(Path.resolve(__dirname, 'temp', 'subtitle.srt'), formatted + '\r\n')
  });
}

async function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout,
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans.trim());
  }))
}

async function mergeVideo(name) {
  return new Promise((resolve, reject) => {
    const progressBar = new ProgressBar('[:bar] :percent :etas', {
      width: 40, complete: '=', incomplete: ' ', renderThrottle: 1, total: 100
    })

    ffmpeg()
      .addInput(Path.resolve(__dirname, 'temp', 'video.m4v'))
      .addInput(Path.resolve(__dirname, 'temp', 'audio.m4a'))
      .addInput(Path.resolve(__dirname, 'temp', 'subtitle.srt'))
      .addOptions(['-map 0', '-map 1', '-map 2', '-c copy', '-c:s mov_text',])
      .on('error', (error) => {
        if (error) {
          console.log(error);
          reject(1);
        }
      })
      .on('progress', (e) => {
        progressBar.tick(e.percent)
      })
      .on('end', () => {
        resolve(1);
      })
      .saveToFile(Path.resolve(__dirname, 'output', name))
  })
}

async function downloadFile(url, filename) {
  return new Promise((resolve, reject) => {
    let writeErr = null;
    const writer = fs.createWriteStream(Path.resolve(__dirname, 'temp', filename), {flags: 'w'})
    writer.on('open', async () => {
      await axios({
        url, method: 'GET', responseType: 'stream'
      }).then(resp => {
        const totalLength = resp.headers['content-length'];
        const progressBar = new ProgressBar('[:bar] :percent :etas', {
          width: 40, complete: '=', incomplete: ' ', renderThrottle: 1, total: parseInt(totalLength)
        })
        resp.data.pipe(writer)
        resp.data.on('data', (chunk) => {
          try {
            progressBar.tick(chunk.length)
          } catch (e) {
          }
        })
      });
    });
    writer.on('error', err => {
      writeErr = err;
      writer.close();
      reject(err)
    });
    writer.on('close', () => {
      if (!writeErr) {
        resolve(1)
      }
    });
    writer.on('finish', () => {
      if (!writeErr) {
        resolve(1)
      }
    });
  });
}

const main = async function () {
  const link = await askQuestion('* Input episode link, eg: https://www.bilibili.tv/vi/play/1060488/11434299\r\n > Your link: ')

  // Link not valid
  if (!episodeRegex.test(link)) {
    console.log('Link not supported.');
    process.exit();
  }

  // get episode id
  const matches = episodeRegex.exec(link)
  const episodeId = matches[1];

  let resp = await axios.get(`https://api.bilibili.tv/intl/gateway/web/playurl?s_locale=vi_VN&platform=web&ep_id=${episodeId}`).then(r => r);

  const videoSources = resp.data.data.playurl.video;
  const audioSources = resp.data.data.playurl.audio_resource;

  resp = await axios.get(`https://api.bilibili.tv/intl/gateway/web/v2/subtitle?s_locale=vi_VN&platform=web&episode_id=${episodeId}`).then(r => r);

  const subtitleSources = resp.data.data.subtitles;

  let selectedVideoIndex = -1;
  while (!Array.from(Array(videoSources.length).keys()).includes(parseInt(selectedVideoIndex)) || !videoSources[selectedVideoIndex].video_resource.url) {
    selectedVideoIndex = await askQuestion('* Please select video quality:\r\n' + videoSources.map((source, i) => {
      return `${i}. ${source.video_resource.width}x${source.video_resource.height} - ${source.video_resource.codecs} - ${(source.video_resource.size / 1024 / 1024).toFixed(2)} MB` + (source.video_resource.url ? '' : ' (PREMIUM ONLY)');
    }).join('\r\n') + '\r\n' + ' > Your select: ');
  }

  let selectedAudioIndex = -1;
  while (!Array.from(Array(audioSources.length).keys()).includes(parseInt(selectedAudioIndex))) {
    selectedAudioIndex = await askQuestion('* Please select audio quality:\r\n' + audioSources.map((source, i) => {
      return `${i}. ${source.quality} - ${source.codecs} - ${(source.size / 1024 / 1024).toFixed(2)} MB`;
    }).join('\r\n') + '\r\n' + ' > Your select: ');
  }

  let selectedSubtitleIndex = -1;
  while (!Array.from(Array(subtitleSources.length).keys()).includes(parseInt(selectedSubtitleIndex))) {
    selectedSubtitleIndex = await askQuestion('* Please select subtitle:\r\n' + subtitleSources.map((source, i) => {
      return `${i}. ${source.lang_key} - ${source.lang}`;
    }).join('\r\n') + '\r\n' + ' > Your select: ');
  }

  const videoUrl = videoSources[selectedVideoIndex].video_resource.url;
  const audioUrl = audioSources[selectedAudioIndex].url;
  const subtitleUrl = subtitleSources[selectedSubtitleIndex].url;

  console.log('Start download video:');
  await downloadFile(videoUrl, 'video.m4v');

  console.log('Start download audio:');
  await downloadFile(audioUrl, 'audio.m4a');

  console.log('Start download subtitle:');
  await downloadFile(subtitleUrl, 'subtitle.json');

  await convert2srt();

  console.log('Merge resources:');
  await mergeVideo('final.mp4');

  // remove temp
  fs.unlinkSync(Path.resolve(__dirname, 'temp', 'video.m4v'));
  fs.unlinkSync(Path.resolve(__dirname, 'temp', 'audio.m4a'));
  fs.unlinkSync(Path.resolve(__dirname, 'temp', 'subtitle.srt'));
  fs.unlinkSync(Path.resolve(__dirname, 'temp', 'subtitle.json'));
}

main();
