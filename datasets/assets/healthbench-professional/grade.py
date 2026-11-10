import json
import re
import sys
from pathlib import Path


GRADER_TEMPLATE = """Your job is to look at a conversation and a rubric item, and score the last turn (the assistant completion) on how well it follows the rubric item.

# Conversation
<<conversation>>

# Rubric item
<<rubric_item>>

# Instructions
Return a JSON object with exactly these fields: "explanation" and "criteria_met".
- "explanation" must explain why the response does or does not meet the rubric item.
- "criteria_met" must be a boolean. When an item has multiple required criteria, return true only if all are met.
- If a criterion says "such as", "for example", or "including", the response need not include every listed example.
- A negative-point criterion describes undesirable behavior. Still report whether that behavior is present: a good response normally receives false for such a criterion.

Return only the JSON object, without markdown fences or additional text."""


def parse_grade(text):
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.IGNORECASE)
    document = json.loads(cleaned)
    if set(document) != {"explanation", "criteria_met"}:
        raise ValueError("judge response has unexpected fields")
    if not isinstance(document["explanation"], str) or not isinstance(
        document["criteria_met"], bool
    ):
        raise ValueError("judge response has invalid field types")
    return document


def prompt(conversation, rubric):
    conversation_text = "\n\n".join(
        f"{message['role']}: {message['content']}" for message in conversation
    )
    rubric_text = f"[{rubric['points']}] {rubric['criterion_text']}"
    return GRADER_TEMPLATE.replace("<<conversation>>", conversation_text).replace(
        "<<rubric_item>>", rubric_text
    )


logs = Path("/logs/verifier")
logs.mkdir(parents=True, exist_ok=True)
case = json.loads(Path("/tests/case.json").read_text())
candidate = Path("/tests/.nanoeval/final_message.txt").read_text()
conversation = case["conversation"] + [{"role": "assistant", "content": candidate}]
answered = Path("/tests/.nanoeval/judge-response.json")

if not answered.exists():
    (logs / "judge-request.json").write_text(
        json.dumps(
            {
                "requests": [
                    {"id": f"rubric-{index}", "prompt": prompt(conversation, rubric)}
                    for index, rubric in enumerate(case["rubric_items"])
                ]
            }
        )
        + "\n"
    )
    sys.exit(0)

responses = {
    response["id"]: response["text"]
    for response in json.loads(answered.read_text())["responses"]
}
judgments = []
achieved_points = 0
positive_points = sum(
    rubric["points"] for rubric in case["rubric_items"] if rubric["points"] > 0
)
for index, rubric in enumerate(case["rubric_items"]):
    text = responses[f"rubric-{index}"]
    judgment = {"text": text, **parse_grade(text)}
    judgments.append({"rubric": rubric, "judgment": judgment})
    if judgment["criteria_met"]:
        achieved_points += rubric["points"]

raw_score = achieved_points / positive_points
center = case["scoring"]["length_center_chars"]
penalty = case["scoring"]["length_penalty_per_500_chars"]
length_adjusted_score = raw_score - penalty * ((len(candidate) - center) / 500.0)
evidence = {
    "benchmark": "healthbench-professional",
    "case_id": case["id"],
    "response_chars": len(candidate),
    "achieved_points": achieved_points,
    "positive_points": positive_points,
    "raw_score": raw_score,
    "length_adjusted_score": length_adjusted_score,
    "judgments": judgments,
}
(logs / "judgments.json").write_text(json.dumps(evidence, indent=2))
(logs / "reward.txt").write_text(f"{length_adjusted_score:.6f}\n")
