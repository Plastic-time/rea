"""Measure only the synthetic producer under the unchanged firmware limits."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

repo = Path.cwd()
flags = re.findall(r'"(--[^" ]+)"', (repo / 'tests/fixtures/firmware/provider.ts').read_text())
node = shutil.which('node')
node_version = subprocess.check_output([node, '--version'], text=True).strip()
if not node_version.startswith('v22.'):
    flags = [flag for flag in flags if flag != '--no-expose-wasm']
observations = []
with tempfile.TemporaryDirectory(prefix='firmware-fixture-', dir=os.environ['RUNNER_TEMP']) as temporary:
    root = Path(temporary)
    for attempt in range(int(os.environ.get('ATTEMPTS', '3'))):
        run = root / str(attempt)
        run.mkdir()
        source = run / 'input.bin'
        source.write_bytes(b'fixture-input-data')
        report = run / 'report.json'
        output = run / 'output'
        timing = run / 'timing.txt'
        environment = dict(os.environ, REA_FIRMWARE_FIXTURE_MODE='nested-unknown-oversized')
        command = ['/usr/bin/time', '-v', '-o', str(timing), 'prlimit', '--as=1073741824', '--fsize=268435456', '--cpu=120', '--', node, *flags, str(repo / 'tests/fixtures/firmware/producer.mjs'), 'unblob', '--extract-dir', str(output), '--report', str(report), '--depth', '1', str(source)]
        result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=30)
        measurement = dict(attempt=attempt, exit=result.returncode, stderr=result.stderr, timing=timing.read_text())
        if result.returncode == 0:
            child = output / 'rootfs/config'
            with child.open('rb') as stream:
                actual = hashlib.file_digest(stream, 'sha256').hexdigest()
            records = json.loads(report.read_text())
            hashes = [item['sha256'] for record in records for item in record['reports'] if item['__typename__'] == 'HashReport']
            measurement.update(size=child.stat().st_size, digest_verified=actual in hashes)
            assert measurement['size'] == 128 * 1024 * 1024 + 1
            assert measurement['digest_verified']
        observations.append(measurement)
print('FIRMWARE_FIXTURE_MEASUREMENTS', json.dumps(dict(node=subprocess.check_output([node, '--version'], text=True).strip(), flags=flags, observations=observations)), flush=True)
if os.environ['EXPECT_SUCCESS'] == '1':
    assert all(item['exit'] == 0 and item['stderr'] == '' for item in observations)
