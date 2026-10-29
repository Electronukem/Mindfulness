# Mindfulness

Turn your work into something calm to watch and listen to.
[graphify](https://github.com/Graphify-Labs/graphify) maps it into a knowledge graph, the graph becomes a
slow, colourful constellation that drifts like a screensaver, and the animation plays generative ambient
music.

- **A GitHub repository**: the code becomes the constellation, and your commits replay one breath at a time.
- **A recorded meeting** (an uploaded video or audio file, or a Zoom cloud recording, plus its slides): the
  ideas become the constellation. It walks you through what was said, one key point at a time, with
  study notes to keep.

## Setup

You need Python 3.11+ and git.

```
pip install "graphifyy[video,pdf,office]"
```

(The PyPI name is `graphifyy` with two y's.) Plain `pip install graphifyy` is enough for repositories.
The extras are for meetings: `video` transcribes recordings locally with faster-whisper, `pdf` reads PDF
slides and `office` reads Word files. PowerPoint files are read without any extra.

Meetings also need an AI model, because graphify uses one to understand a conversation. If
[Claude Code](https://claude.ai/code) is installed and signed in, it's used automatically and runs on
your subscription. Otherwise set `ANTHROPIC_API_KEY`, or another key graphify supports (`GEMINI_API_KEY`,
`OPENAI_API_KEY`, …). The start screen shows what's ready.

## Run

```
python server.py
```

On Windows, double-click `start.bat` instead. It uses the project's `.venv` if there is one. A browser
tab opens at http://127.0.0.1:8765, and http://127.0.0.1:8765/#meeting opens straight to the meeting
tab.

| Key | Does |
| --- | --- |
| F | Full screen |
| M | Mute |
| O | Orchestra and themes |
| ← → | Previous or next key point (meetings) |
| Space | Hold the current point (meetings) |
| N | Study notes (meetings) |

The controls fade after a few seconds without mouse movement.

Options: `python server.py --port 9000 --max-nodes 800 --no-browser`

## Repositories

Paste a public repository link (`https://github.com/owner/repo`, `owner/repo`, or a `/tree/<branch>`
link) and press **Begin**.

1. The server shallow-clones the repository (the last 400 commits, with no old file contents) and runs
   `graphify extract <repo> --code-only`. That step parses the code locally and needs no AI.
2. graphify's communities, which are clusters of closely related code, each get a colour and drift
   around their own slowly wandering point. The sky turns once every ten minutes and gently expands and
   contracts with each chord, like a slow breath.
3. Your commits replay in order, one per breath. The code each commit touched lights up as a short phrase,
   its names float up beside it, and the commit message appears at the bottom.
4. Between commits, light wanders along the graph's edges, and each pulse rings as it reaches a node.

| From the repository | Becomes |
| --- | --- |
| Time of day of the commits (author's local time) | Mode: daytime work is lydian or major, late nights are dorian or minor |
| Commits per week | Tempo, 54–72 bpm, with one chord per breath |
| Main language | The lead soloist: glass bells (Python and similar), kalimba (JS/TS/web), vibraphone (C, Rust, Go, Java and similar), felt piano (other languages) |
| Size of the graph | How long the reverb rings |
| How connected the code is | How often light travels between ideas |
| Repository name | Key and chord progression |

## Meetings

Choose **A recorded meeting**. Add the recording (mp4, mov, m4a, mp3, wav, webm, mkv…) or pick one from
Zoom. Add the slides or notes that went with it if you have them (PowerPoint, PDF, Word, Markdown or
text). Then press **Begin**.

1. **Transcript.** If Zoom recorded an audio transcript, it's used as is, with speaker names. Otherwise the
   audio is transcribed on this computer with faster-whisper. That takes a few minutes per hour of audio,
   and the speech model downloads the first time. Set `GRAPHIFY_WHISPER_MODEL=small` for better accuracy
   at a slower pace.
2. **Slides.** Each slide's title, text and speaker notes are read.
3. **Map of ideas.** graphify reads the transcript and slides and builds a graph of the concepts discussed,
   grouped into named topics. This is the slow part.
4. **Study notes.** One more AI call writes a short summary, chapters with takeaways, key points (each
   tagged with the concepts it's about), key terms, decisions, action items and open questions.

The replay is paced for learning. Each chapter opens with its title and takeaway, then its key points
follow, one every two breaths (about 15–18 seconds). Each point lights up the concepts it's about, and
topic names float faintly over their clusters. Step back and forth with ← and →, or hold a point with
Space. **Study notes** lists everything, and clicking a chapter or point jumps there. **Download .md**
saves the notes.

The music is quieter and steadier than for code: a slower tempo, a felt piano lead, and no choir by
default, because voices compete with reading. The mood comes from the meeting. Many open questions make
it dorian (thoughtful), and settled decisions make it major (warm). Speaking pace sets the tempo.

### Zoom

Zoom recordings are read through a *Server-to-Server OAuth* app that you create in your own Zoom account:

1. In the [Zoom App Marketplace](https://marketplace.zoom.us/), choose Develop → Build App →
   **Server-to-Server OAuth**.
2. Under Scopes, add `cloud_recording:read:list_user_recordings:admin`, then activate the app.
3. In Mindfulness, click **Zoom** and enter the app's Account ID, Client ID and Client secret, plus the email of
   the Zoom account that owns the recordings.

The credentials are checked, then saved only on this computer in `zoom.json`, which git ignores. You can
set `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` and `ZOOM_USER` instead. The list shows cloud
recordings from the last 90 days. Recordings need a paid Zoom plan with cloud recording, and Zoom only
writes transcripts if audio transcription was turned on before the meeting.

### What leaves your computer

Recordings and uploads stay on this computer, and local transcription runs offline. The **transcript text
and slide text are sent to the AI model** (Claude through Claude Code, or whichever API key is set) to
build the map of ideas and the study notes. Don't use meetings whose contents you're not allowed to share
with that service. The study notes are written by AI, so check anything important against the recording.

## The orchestra and themes

Click **Orchestra** (or press **O**) to change who plays and how it feels. Choices are remembered in
this browser, separately for repositories and meetings.

- **Ensemble** plays the chords, one per breath: strings, cellos and basses, choir, and a drone.
- **Soloists** play when light reaches a node: harp, flute, felt piano, glass bells, kalimba,
  vibraphone and pizzicato strings. Each coloured cluster is given to one soloist, and the dots next to an
  instrument show which clusters it plays. The harp also rolls each chord.
- Each instrument has its own on/off switch and volume slider. The reset button returns to the suggestion.
- **Themes** change the colours and the mood together. **From your work** (or **From the meeting**)
  reads the mode and tempo from the source. **Night sky**, **Ocean**, **Forest**, **Ember**, **Aurora**
  and **Dawn** each set their own palette, mode, tempo and room size.

Everything is synthesised in the browser with Web Audio (no samples), and the instruments are
level-matched so any mix stays balanced.

## Notes

- Results are cached in `.cache/`, so anything you've seen before opens instantly from the chips on the
  start screen. Delete `.cache/` to reclaim disk space (uploaded recordings are kept there too).
- Only public repositories work, because nothing asks for GitHub credentials.
- Very large graphs are trimmed to the most connected 1,500 nodes (`--max-nodes`).
- The page loads d3 from cdnjs and fonts from Google Fonts, so it needs an internet connection.
- The server listens only on 127.0.0.1.
