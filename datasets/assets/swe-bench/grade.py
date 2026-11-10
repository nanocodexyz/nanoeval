import json
import sys
from pathlib import Path

from swebench.harness.constants import (
    FAIL_ONLY_REPOS,
    FAIL_TO_PASS,
    KEY_INSTANCE_ID,
    PASS_TO_PASS,
    EvalType,
    ResolvedStatus,
)
from swebench.harness.grading import (
    get_eval_tests_report,
    get_logs_eval,
    get_resolution_status,
)
from swebench.harness.test_spec.test_spec import make_test_spec

logs = Path("/logs/verifier")
instance = json.loads(Path("/tests/instance.json").read_text())
spec = make_test_spec(instance)

if sys.argv[1] == "script":
    sys.stdout.write(spec.eval_script)
    sys.exit(0)

statuses, found = get_logs_eval(spec, str(logs / "test-output.txt"))
report = {
    "instance_id": spec.instance_id,
    "tests_ran": found,
    "resolved": False,
}
if found:
    tests = get_eval_tests_report(
        statuses,
        {
            KEY_INSTANCE_ID: spec.instance_id,
            FAIL_TO_PASS: spec.FAIL_TO_PASS,
            PASS_TO_PASS: spec.PASS_TO_PASS,
        },
        eval_type=EvalType.FAIL_ONLY
        if spec.repo in FAIL_ONLY_REPOS
        else EvalType.PASS_AND_FAIL,
    )
    report["tests_status"] = tests
    report["resolved"] = get_resolution_status(tests) == ResolvedStatus.FULL.value

(logs / "report.json").write_text(json.dumps(report, indent=2) + "\n")
(logs / "reward.txt").write_text("1\n" if report["resolved"] else "0\n")
