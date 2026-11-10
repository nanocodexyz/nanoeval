
import json, sys, pathlib
from harbor.models.job.config import JobConfig
from harbor.models.job.result import JobResult, JobStats
from harbor.models.trial.config import TrialConfig
from harbor.models.trial.result import TrialResult
from harbor.models.trajectories import Trajectory
root = pathlib.Path(sys.argv[1])
ok = True
count = {'ok': 0, 'fail': 0}
def check(label, fn):
    global ok
    try:
        fn(); count['ok'] += 1
    except Exception as e:
        ok = False; count['fail'] += 1
        print('FAIL', label); print('   ', str(e)[:1500].replace('\n', '\n    '))
job = {}
check('job result.json', lambda: job.setdefault('r', JobResult.model_validate_json((root / 'result.json').read_text())))
check('job config.json', lambda: JobConfig.model_validate_json((root / 'config.json').read_text()))
trials = []
for trial in sorted(p for p in root.iterdir() if p.is_dir()):
    check(trial.name + '/result.json', lambda: trials.append(TrialResult.model_validate_json((trial / 'result.json').read_text())))
    check(trial.name + '/config.json', lambda: TrialConfig.model_validate_json((trial / 'config.json').read_text()))
    t = trial / 'agent' / 'trajectory.json'
    if t.exists():
        check(trial.name + '/agent/trajectory.json', lambda: Trajectory.model_validate_json(t.read_text()))
def stats():
    mine = job['r'].stats
    theirs = JobStats.from_trial_results(trials)
    assert mine.n_completed_trials == theirs.n_completed_trials, (mine.n_completed_trials, theirs.n_completed_trials)
    assert mine.n_errored_trials == theirs.n_errored_trials, (mine.n_errored_trials, theirs.n_errored_trials)
    assert len({t.id for t in trials}) == len(trials)
    assert all(t.config.job_id == job['r'].id for t in trials)
check('job stats agree with Harbor recomputed from the trials', stats)
print(root, count)
sys.exit(0 if ok else 1)

