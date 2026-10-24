"""Bounded Linux CLI replay of #5659; synthetic gzip extractor, no target execution."""
import collections
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

root = Path(tempfile.mkdtemp(prefix="rea-fox-5672-", dir=os.environ["RUNNER_TEMP"]))
repo = Path.cwd()
results_dir = repo / "fox-verification-results"
results_dir.mkdir(exist_ok=True)
payload = b"firmware payload\n" * 200
source = root / "fw.bin"
source.write_bytes(gzip.compress(payload, mtime=0))
extractor = root / "unblob"
extractor.write_text('''#!/usr/bin/env python3
import gzip, hashlib, json, pathlib, sys
args=sys.argv[1:]
if args == ['--version']:
 print('26.6.4'); sys.exit(0)
source=pathlib.Path(args[-1]); raw=source.read_bytes()
out=pathlib.Path(args[args.index('--extract-dir')+1]); out.mkdir(parents=True)
child=out/'payload'; payload=gzip.decompress(raw); child.write_bytes(payload)
def task(path,depth,blob):
 return dict(path=str(path),depth=depth,blob_id=blob,is_multi_file=False)
def reports(path,data):
 return [dict(__typename__='StatReport',path=str(path),size=len(data),is_file=True,is_dir=False,is_link=False,link_target=None),dict(__typename__='HashReport',sha256=hashlib.sha256(data).hexdigest())]
ct=task(child,1,'gzip-1')
chunk=dict(__typename__='ChunkReport',id='gzip-1',start_offset=0,end_offset=len(raw),size=len(raw),handler_name='gzip',is_encrypted=False,extraction_reports=[])
records=[dict(task=task(source,0,''),reports=reports(source,raw)+[chunk],subtasks=[ct]),dict(task=ct,reports=reports(child,payload),subtasks=[])]
pathlib.Path(args[args.index('--report')+1]).write_text(json.dumps(records))
''')
extractor.chmod(0o755)

def values(value, key):
    found = []
    if isinstance(value, dict):
        if key in value:
            found.append(value[key])
        for child in value.values():
            found.extend(values(child, key))
    elif isinstance(value, list):
        for child in value:
            found.extend(values(child, key))
    return found

def run(label, budget, mode=None):
    work = root / label
    work.mkdir()
    env = {"PATH": os.environ["PATH"], "REA_LOG_LEVEL": "silent", "REA_UNBLOB_COMMAND": str(extractor)}
    for name, directory in [("HOME", "home"), ("XDG_CONFIG_HOME", "cfg"), ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state"), ("TMPDIR", "tmp")]:
        (work / directory).mkdir()
        env[name] = str(work / directory)
    command = [shutil.which("node")]
    if mode:
        env["FOX_READ_MODE"] = mode
        command += ["--import", str(repo / "scripts/verify-fox-5672-read-hook.mjs")]
    output = work / "output"
    command += ["scripts/rea.mjs", "extract-firmware", str(source), str(output)]
    if budget is not None:
        command += ["--publication-timeout-ms", str(budget)]
    command += ["--json"]
    start = time.monotonic()
    try:
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return dict(label=label, budget=budget, outcome="hung", elapsed_ms=60000)
    elapsed = (time.monotonic() - start) * 1000
    try:
        document = json.loads(result.stdout)
    except ValueError:
        document = None
    codes = values(document, "code")
    outcome = "success" if result.returncode == 0 else "timeout" if "provider_timeout" in codes else "structured_error" if document is not None else "crash_or_non_json"
    record = dict(label=label, budget=budget, mode=mode, outcome=outcome, exit=result.returncode, elapsed_ms=round(elapsed, 1), codes=codes, phases=values(document, "phase"), progress=values(document, "publication"), output_exists=output.exists(), bytes_match=(output / "payload").exists() and (output / "payload").read_bytes() == payload, unhandled="Unhandled 'error' event" in result.stderr, injection_confirmed="FOX_PENDING_READ" in result.stderr)
    if mode or outcome not in ("timeout", "success") or label.startswith("control"):
        (results_dir / (label + ".stdout.json")).write_text(result.stdout)
        (results_dir / (label + ".stderr.txt")).write_text(result.stderr)
    return record

node = subprocess.check_output(["node", "--version"], text=True).strip()
records = [run("control-60000", 60000), run("control-default", None)]
if any(r["outcome"] != "success" or not r["bytes_match"] for r in records):
    print(json.dumps({"node": node, "controls_failed": records}, indent=2), flush=True)
    (results_dir / "records.json").write_text(json.dumps(records, indent=2))
    raise SystemExit(1)
for i in range(120):
    records.append(run(f"race-{i:03}", 2 + i % 9))
    if (i + 1) % 20 == 0:
        print(json.dumps({"node": node, "completed": i+1, "counts": dict(collections.Counter(r["outcome"] for r in records))}), flush=True)
if node.startswith("v24."):
    for i in range(200):
        records.append(run(f"one-ms-{i:03}", 1))
        if (i + 1) % 50 == 0:
            print(json.dumps({"node": node, "one_ms_completed": i+1}), flush=True)
for mode in ("fulfill", "reject"):
    records.append(run("pending-" + mode, 250, mode))
summary = {"node": node, "source_commit": "7349ea854dbd5d883b5dc0486e65abd4bf6c6998", "filesystem": subprocess.check_output(["findmnt", "-n", "-o", "FSTYPE", "-T", str(root)], text=True).strip(), "counts": dict(collections.Counter(r["outcome"] for r in records)), "races": dict(collections.Counter(r["outcome"] for r in records if r["label"].startswith("race-"))), "one_ms": dict(collections.Counter(r["outcome"] for r in records if r["label"].startswith("one-ms-"))), "max_call_ms": max(r["elapsed_ms"] for r in records), "timeout_outputs_retained": sum(r["outcome"] == "timeout" and r["output_exists"] for r in records), "timeouts_missing_progress": sum(r["outcome"] == "timeout" and not r["progress"] for r in records), "pending_read": [r for r in records if r.get("mode")]}
(results_dir / "records.json").write_text(json.dumps(records, indent=2))
(results_dir / "summary.json").write_text(json.dumps(summary, indent=2))
print(json.dumps(summary, indent=2), flush=True)
assert not any(r["outcome"] in ("hung", "crash_or_non_json") or r.get("unhandled") for r in records)
assert all(r["bytes_match"] for r in records if r["outcome"] == "success")
assert all(r["injection_confirmed"] for r in records if r.get("mode"))
