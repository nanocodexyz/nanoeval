import json
import re
from pathlib import Path


logs = Path("/logs/verifier")
logs.mkdir(parents=True, exist_ok=True)
case = json.loads(Path("/tests/case.json").read_text())
answer = Path("/tests/.nanoeval/final_message.txt").read_text(errors="replace")
patterns = [
    r"answer is \((.)\)",
    r"Answer: \((.)\)",
    r"answer: \((.)\)",
    r"answer \((.)\)",
    r"\((.)\)",
]
selected = None
for pattern in patterns:
    match = re.search(pattern, answer)
    if match:
        selected = match.group(1)
        break
correct = selected == case["correct_answer"]
(logs / "reward.txt").write_text("1\n" if correct else "0\n")
(logs / "gpqa.json").write_text(
    json.dumps(
        {
            "record_id": case["record_id"],
            "selected": selected,
            "correct": correct,
        },
        indent=2,
    )
    + "\n"
)
