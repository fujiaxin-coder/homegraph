"""LLM-as-Judge Answer Accuracy (0–1), dual-prompt average — standalone, no ragas."""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass

from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

TEMPLATE_ACCURACY1 = (
    "Instruction: You are an assistant for rating a User Answer given a Question. "
    "The Question is fully answered by the Reference Answer.\n"
    "Focus on whether the User Answer captures the key meaning and intent of the Reference Answer. "
    "Minor wording differences, alternative phrasing, or extra irrelevant information should not lower the rating.\n"
    "Say 5, if the User Answer conveys the same overall meaning and essential content as the Reference Answer.\n"
    "Say 4, if the User Answer is mostly correct, broadly aligned with the Reference Answer, with only small omissions or slight issues.\n"
    "Say 3, if the User Answer is reasonably correct, covering several important aspects of the Reference Answer, even if incomplete.\n"
    "Say 2, if the User Answer shows some overlap, but misses many essential aspects.\n"
    "Say 1, if the User Answer has very little overlap with the Reference Answer.\n"
    "Say 0, if the User Answer does not address the question at all.\n"
    "Do not explain or justify your rating. Your rating must be a single integer 0–5.\n"
    "If the User Answer is empty, the rating is 0.\n"
    "### Question: {query}\n"
    "### {answer0}: {sentence_inference}\n"
    "### {answer1}: {sentence_true}\n"
    "The rating is:\n"
)

TEMPLATE_ACCURACY2 = (
    "I will rate the User Answer in comparison to the Reference Answer for a given Question.\n"
    "The evaluation must focus mainly on whether the User Answer conveys the essential meaning and intent of the Reference Answer. "
    "Minor details, alternative phrasing, or extra content should not strongly affect the rating.\n"
    "If the User Answer is empty, the rating is 0.\n"
    "The scale is 0 to 5:\n"
    "0 = Does not address the question at all\n"
    "1 = Very limited overlap with the Reference Answer\n"
    "2 = Some overlap, but misses many essential aspects\n"
    "3 = Reasonably correct, covers several important aspects but incomplete\n"
    "4 = Mostly correct, broadly aligned with the Reference Answer with only small gaps\n"
    "5 = Fully correct, conveys the same overall meaning and essential content as the Reference Answer\n"
    "I will provide the rating as a single integer 0–5 without explanation.\n\n"
    "Question: {query}\n\n"
    "{answer0}: {sentence_inference}\n\n"
    "{answer1}: {sentence_true}\n\n"
    "Rating: "
)


def remove_tool_calls(text: str) -> str:
    """Strip --- ... --- blocks that contain agent tool invocations before judging."""
    pattern = re.compile(
        r"---\s*[\s\S]*?"
        r"(ReadFile|SearchText|ReadManyFiles|ReadFolder|SemanticSearch|FindFiles|Custom|HomegraphQuery|HomegraphExplore)"
        r"[\s\S]*?---",
        re.MULTILINE,
    )
    cleaned = re.sub(pattern, "", text)
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def extract_json_blocks_answerbyCOT(text: str) -> str:
    """Remove redacted_thinking blocks from chain-of-thought model output."""
    cleaned = re.sub(
        r"<think>.*?</think>",
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    return cleaned.strip()


def process_score(response: str) -> float:
    for i in range(6):
        if str(i) in response.strip():
            return i / 5
    return math.nan


def average_scores(score0: float, score1: float) -> float:
    if not math.isnan(score0) and not math.isnan(score1):
        return (score0 + score1) / 2
    if math.isnan(score0) and math.isnan(score1):
        return math.nan
    return score0 if math.isnan(score1) else score1


@dataclass
class MyAnswerAccuracy:
    """Dual-template LLM judge; scores normalized to 0–1."""

    client: AsyncOpenAI
    model: str
    retry: int = 5
    extra_body: dict | None = None

    @classmethod
    def create(
        cls,
        *,
        api_key: str,
        base_url: str,
        model: str,
        timeout_sec: float = 1800,
        extra_body: dict | None = None,
    ) -> MyAnswerAccuracy:
        client = AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=timeout_sec)
        return cls(client=client, model=model, extra_body=extra_body)

    async def _chat(self, prompt: str) -> str:
        kwargs: dict = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.10,
        }
        if self.extra_body:
            kwargs["extra_body"] = self.extra_body
        resp = await self.client.chat.completions.create(**kwargs)
        return (resp.choices[0].message.content or "").strip()

    async def _rate(self, prompt: str) -> float:
        for attempt in range(self.retry):
            try:
                text = await self._chat(prompt)
                score = process_score(text)
                if not math.isnan(score):
                    return score
            except Exception as e:
                logger.warning("Judge call failed (attempt %s): %s", attempt + 1, e)
            logger.warning("Judge retry (invalid rating): %s", attempt + 1)
        return math.nan

    async def single_turn_ascore(
        self,
        *,
        user_input: str,
        response: str,
        reference: str,
    ) -> float:
        prompt1 = TEMPLATE_ACCURACY1.format(
            query=user_input,
            answer0="User Answer",
            answer1="Reference Answer",
            sentence_inference=response,
            sentence_true=reference,
        )
        prompt2 = TEMPLATE_ACCURACY2.format(
            query=user_input,
            answer0="Reference Answer",
            answer1="User Answer",
            sentence_inference=reference,
            sentence_true=response,
        )
        try:
            s0 = await self._rate(prompt1)
            s1 = await self._rate(prompt2)
            return average_scores(s0, s1)
        except Exception as e:
            logger.warning("Judge error: %s", e)
            return math.nan

    async def evaluate_answer_accuracy_single(self, sample_data: dict) -> dict:
        result = sample_data.copy()
        try:
            raw = str(sample_data.get("output_answer", ""))
            raw = extract_json_blocks_answerbyCOT(raw)
            response = remove_tool_calls(raw)
            score = await self.single_turn_ascore(
                user_input=str(sample_data.get("query", "")),
                response=response,
                reference=str(sample_data.get("reference_answer", "")),
            )
            result["answer_accuracy_score"] = float(score) if not math.isnan(score) else 0.0
            result["evaluation_status"] = "success" if not math.isnan(score) else "failed"
            if math.isnan(score):
                result["error_message"] = "Judge 未返回有效 0–5 分数"
        except Exception as e:
            logger.error("评估答案准确性时出错: %s", e)
            result["answer_accuracy_score"] = 0.0
            result["evaluation_status"] = "error"
            result["error_message"] = str(e)

        result.pop("evaluation", None)
        return result
