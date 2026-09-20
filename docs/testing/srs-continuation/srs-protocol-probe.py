#!/usr/bin/env python3
"""Probe disposable SRS callback identity and disconnect behavior without Bee or funds."""

import json
import pathlib
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / 'evidence'
PREFIX = 'srs-continuation-probe-20260920'
LABEL = 'srs-continuation-probe=20260920'
SRS_PORT = 28102
SRT_PORT = 28103
API = 'http://127.0.0.1:28101'
HOOKS = 'http://127.0.0.1:28100'
created = []
senders = []
ABR = '--abr' in sys.argv


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def request(url, method='GET'):
    with urllib.request.urlopen(urllib.request.Request(url, method=method), timeout=10) as response:
        return json.load(response)


def snapshot(name):
    readings = {}
    for path in ['/api/v1/summaries', '/api/v1/streams', '/api/v1/clients']:
        try:
            readings[path] = request(API + path)
        except Exception as error:
            readings[path] = {'error': str(error)}
    readings['dockerStats'] = run(['docker', 'stats', '--no-stream', '--format', '{{json .}}'])
    (OUT / (name + '.json')).write_text(json.dumps(readings, indent=2) + '\n')


def start_sender(name, protocol, stream):
    url = (f'rtmp://127.0.0.1:{SRS_PORT}/live/{stream}' if protocol == 'rtmp'
           else f'srt://127.0.0.1:{SRT_PORT}?streamid=#!::r=live/{stream},m=publish')
    logfile = (OUT / (name + '.log')).open('w')
    args = ['ffmpeg', '-hide_banner', '-loglevel', 'warning', '-re', '-f', 'lavfi',
            '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
            '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-tune', 'zerolatency',
            '-g', '25', '-c:a', 'aac', '-b:a', '64k', '-t', '90',
            '-f', 'flv' if protocol == 'rtmp' else 'mpegts', url]
    process = subprocess.Popen(args, stdout=logfile, stderr=subprocess.STDOUT)
    senders.append((process, logfile))
    return process


def stop_sender(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def wait_media(stream, after_count=0, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        events = request(HOOKS + '/events')
        media = [event for event in events if event.get('body', {}).get('action') == 'on_hls'
                 and event['body'].get('stream') == stream]
        if len(media) > after_count:
            return media
        time.sleep(0.5)
    raise RuntimeError(f'No new on_hls for {stream}')


def main():
    OUT.mkdir(exist_ok=False)
    for kind, name in [('network', PREFIX), ('container', PREFIX + '-hooks'), ('container', PREFIX + '-srs')]:
        result = subprocess.run(['docker', kind, 'inspect', name], capture_output=True)
        if result.returncode == 0:
            raise RuntimeError(f'Refusing an existing {kind}: {name}')
    facts = {'srsImage': run(['docker', 'image', 'inspect', 'ossrs/srs:6', '--format', '{{.Id}} {{json .RepoDigests}}']),
             'nodeImage': run(['docker', 'image', 'inspect', 'node:22-alpine', '--format', '{{.Id}}']),
             'engine': run(['docker', 'version', '--format', '{{.Server.Version}}']),
             'compose': run(['docker', 'compose', 'version']),
             'ffmpeg': run(['ffmpeg', '-version']),
             'containersBefore': run(['docker', 'ps', '--format', '{{.Names}} {{.Image}} {{.Status}}'])}
    (OUT / 'facts.json').write_text(json.dumps(facts, indent=2) + '\n')
    (ROOT / 'hooks.mjs').write_text("""import http from 'node:http';
const events = [];
let denied = false;
http.createServer((req, res) => {
  if (req.url === '/events') { res.end(JSON.stringify(events)); return; }
  if (req.url === '/deny') { denied = true; res.end('0'); return; }
  if (req.url === '/allow') { denied = false; res.end('0'); return; }
  let body = '';
  req.on('data', part => { body += part; if (body.length > 65536) req.destroy(); });
  req.on('end', () => {
    const event = { at: Date.now(), body: JSON.parse(body) };
    events.push(event);
    console.log(JSON.stringify(event));
    res.end(denied && event.body.action === 'on_publish' ? '1' : '0');
  });
}).listen(8080, '0.0.0.0');
""")
    (ROOT / 'srs.conf').write_text("""listen 28102 127.0.0.1:1935;
max_connections 20;
daemon off;
srs_log_tank console;
http_api { enabled on; listen 1985; }
srt_server { enabled on; listen 10080; }
vhost __defaultVhost__ {
    srt { enabled on; }
    hls {
        enabled on;
        hls_path ./objs/nginx/html;
        hls_fragment 1;
        hls_window 10;
        hls_ts_file [app]/[stream]/[stream]-[seq].ts;
        hls_m3u8_file [app]/[stream]/index.m3u8;
    }
    http_hooks {
        enabled on;
        on_publish http://hooks:8080/hooks;
        on_unpublish http://hooks:8080/hooks;
        on_hls http://hooks:8080/hooks;
    }
}
""")
    if ABR:
        config = (ROOT / 'srs.conf').read_text()
        config = config.replace('    http_hooks {', '''    transcode {
        enabled on;
        ffmpeg ./objs/ffmpeg/bin/ffmpeg;
        engine small {
            enabled on;
            iformat flv;
            oformat flv;
            vcodec libx264;
            vbitrate 250;
            vfps 25;
            vwidth 320;
            vheight 180;
            vthreads 1;
            vprofile baseline;
            vpreset ultrafast;
            vparams { g 25; keyint_min 25; sc_threshold 0; }
            acodec copy;
            output rtmp://127.0.0.1:1935/[app]/[stream]_small?vhost=abr;
        }
    }
    http_hooks {''', 1)
        config += '''
vhost abr {
    hls {
        enabled on;
        hls_path ./objs/nginx/html;
        hls_fragment 1;
        hls_window 10;
        hls_ts_file [app]/[stream]/[stream]-[seq].ts;
        hls_m3u8_file [app]/[stream]/index.m3u8;
    }
    http_hooks {
        enabled on;
        on_publish http://hooks:8080/hooks;
        on_unpublish http://hooks:8080/hooks;
        on_hls http://hooks:8080/hooks;
    }
}
'''
        (ROOT / 'srs.conf').write_text(config)
    run(['docker', 'network', 'create', '--label', LABEL, PREFIX])
    created.append(('network', PREFIX))
    run(['docker', 'run', '-d', '--pull=never', '--name', PREFIX + '-hooks', '--label', LABEL,
         '--network', PREFIX, '--network-alias', 'hooks', '--cpus', '0.25', '--memory', '128m',
         '-p', '127.0.0.1:28100:8080', '-v', str(ROOT) + ':/probe:ro',
         'node:22-alpine', 'node', '/probe/hooks.mjs'])
    created.append(('container', PREFIX + '-hooks'))
    run(['docker', 'run', '-d', '--pull=never', '--name', PREFIX + '-srs', '--label', LABEL,
         '--network', PREFIX, '--cpus', '2', '--memory', '1g',
         '-p', '127.0.0.1:28101:1985', '-p', '127.0.0.1:28102:28102',
         '-p', '127.0.0.1:28103:10080/udp', '-v', str(ROOT / 'srs.conf') + ':/probe/srs.conf:ro',
         'ossrs/srs:6', './objs/srs', '-c', '/probe/srs.conf'])
    created.append(('container', PREFIX + '-srs'))
    for attempt in range(30):
        try:
            request(API + '/api/v1/versions')
            break
        except Exception:
            time.sleep(0.5)
    snapshot('before')
    outcomes = []
    for protocol in ['rtmp', 'srt']:
        stream = 'probe-' + protocol
        first = start_sender(protocol + '-A', protocol, stream)
        initial = wait_media(stream)
        if ABR:
            wait_media(stream + '_small')
        overlapping = start_sender(protocol + '-busy-B', protocol, stream)
        time.sleep(4)
        events = request(HOOKS + '/events')
        before_stop = request(API + '/api/v1/streams')
        stop_sender(overlapping)
        stop_sender(first)
        time.sleep(2)
        count = len([event for event in request(HOOKS + '/events') if event.get('body', {}).get('action') == 'on_hls'
                     and event['body'].get('stream') == stream])
        resumed = start_sender(protocol + '-C', protocol, stream)
        later = wait_media(stream, count)
        active = request(API + '/api/v1/streams')
        selected = next(row for row in active['streams'] if row.get('name') == stream)
        client_id = selected['publish']['cid']
        deletion = request(API + '/api/v1/clients/' + str(client_id), method='DELETE')
        time.sleep(3)
        after_delete = request(API + '/api/v1/streams')
        stop_sender(resumed)
        request(HOOKS + '/deny')
        denied = start_sender(protocol + '-denied-D', protocol, stream + '-denied')
        time.sleep(4)
        denied_streams = request(API + '/api/v1/streams')
        stop_sender(denied)
        request(HOOKS + '/allow')
        silent = start_sender(protocol + '-silent-E', protocol, stream + '-silent')
        wait_media(stream + '-silent')
        silence_started = int(time.time() * 1000)
        silent.send_signal(signal.SIGSTOP)
        silence_events = []
        for _ in range(70):
            silence_events = [event for event in request(HOOKS + '/events')
                              if event.get('body', {}).get('stream') == stream + '-silent'
                              and event['body'].get('action') == 'on_unpublish']
            if silence_events:
                break
            time.sleep(0.5)
        silent.send_signal(signal.SIGCONT)
        stop_sender(silent)
        outcomes.append({'protocol': protocol, 'firstMedia': initial[0], 'overlapEvents': events,
                         'beforeStop': before_stop, 'resumedMedia': later[-1],
                         'deleteClient': client_id, 'deleteResponse': deletion,
                         'afterDelete': after_delete, 'deniedStreams': denied_streams,
                         'abrProbe': ABR, 'silenceStarted': silence_started,
                         'silenceUnpublish': silence_events})
        print(f'{protocol}: callback, busy, reconnect, client-delete and refusal probes recorded', flush=True)
    snapshot('after')
    (OUT / 'events.json').write_text(json.dumps(request(HOOKS + '/events'), indent=2) + '\n')
    (OUT / 'outcomes.json').write_text(json.dumps(outcomes, indent=2) + '\n')


try:
    main()
finally:
    for process, logfile in senders:
        stop_sender(process)
        logfile.close()
    for kind, name in reversed(created):
        if kind == 'container':
            logs = subprocess.run(['docker', 'logs', name], capture_output=True, text=True)
            (OUT / (name + '.log')).write_text(logs.stdout + logs.stderr)
            if name.endswith('-srs'):
                encoder_logs = subprocess.run(['docker', 'exec', name, 'find', '/usr/local/srs/objs',
                                               '-maxdepth', '1', '-type', 'f', '-name', 'ffmpeg*.log',
                                               '-exec', 'cat', '{}', '+'], capture_output=True, text=True)
                (OUT / 'srs-encoder-logs.txt').write_text(encoder_logs.stdout + encoder_logs.stderr)
            subprocess.run(['docker', 'rm', '-f', name], check=True, capture_output=True)
        else:
            subprocess.run(['docker', 'network', 'rm', name], check=True, capture_output=True)
