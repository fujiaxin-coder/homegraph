"""LLM provider presets for qa_eval (DashScope Qwen / 智谱 Zhipu)."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class LlmConfig:
    provider: str
    api_key: str
    base_url: str
    model: str
    extra_body: dict | None


PROVIDER_DASHSCOPE = "dashscope"
PROVIDER_ZHIPU = "zhipu"

_PRESETS: dict[str, dict] = {
    PROVIDER_DASHSCOPE: {
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": "qwen3-235b-a22b-instruct-2507",
        "api_key_envs": ("DASHSCOPE_API_KEY", "OPENAI_API_KEY"),
        "extra_body": {"enable_thinking": False},
    },
    PROVIDER_ZHIPU: {
        "base_url": "https://open.bigmodel.cn/api/paas/v4/",
        "model": "glm-4-flash",
        "api_key_envs": ("ZHIPU_API_KEY", "ZAI_API_KEY", "OPENAI_API_KEY"),
        "extra_body": None,
    },
}


def _read_key(env_names: tuple[str, ...]) -> str | None:
    for name in env_names:
        val = os.environ.get(name, "").strip()
        if val:
            return val
    return None


def detect_provider() -> str:
    """Prefer explicit ZHIPU key over DashScope when both are set."""
    if _read_key(_PRESETS[PROVIDER_ZHIPU]["api_key_envs"]):
        return PROVIDER_ZHIPU
    if _read_key(_PRESETS[PROVIDER_DASHSCOPE]["api_key_envs"]):
        return PROVIDER_DASHSCOPE
    return PROVIDER_DASHSCOPE


def resolve_llm_config(
    *,
    provider: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
) -> LlmConfig:
    name = (provider or detect_provider()).strip().lower()
    if name not in _PRESETS:
        known = ", ".join(_PRESETS)
        raise ValueError(f"未知 LLM provider: {provider!r}，可选: {known}")

    preset = _PRESETS[name]
    api_key = _read_key(preset["api_key_envs"])
    if not api_key:
        env_hint = " / ".join(preset["api_key_envs"])
        raise RuntimeError(
            f"未找到 {name} 的 API Key。请设置环境变量: {env_hint}\n"
            f"  智谱: export ZHIPU_API_KEY='your-id.your-secret'\n"
            f"  DashScope: export DASHSCOPE_API_KEY='sk-...'"
        )

    # Strip mistaken sk- prefix on Zhipu keys (id.secret format).
    if name == PROVIDER_ZHIPU and api_key.startswith("sk-") and "." in api_key[3:]:
        api_key = api_key[3:]

    return LlmConfig(
        provider=name,
        api_key=api_key,
        base_url=(base_url or preset["base_url"]).rstrip("/") + "/",
        model=model or preset["model"],
        extra_body=preset["extra_body"],
    )


def provider_help() -> str:
    return (
        f"dashscope (默认 Qwen, { _PRESETS[PROVIDER_DASHSCOPE]['model']}) | "
        f"zhipu (智谱, 默认 { _PRESETS[PROVIDER_ZHIPU]['model']})"
    )
