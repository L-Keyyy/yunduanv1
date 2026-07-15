import { jsonrepair } from "jsonrepair";

export type StructuredJsonParseResult<T = unknown> = {
  value: T;
  repaired: boolean;
};

function fencedContent(raw: string) {
  const match = raw.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() || "";
}

function firstJsonContainer(raw: string) {
  const objectIndex = raw.indexOf("{");
  const arrayIndex = raw.indexOf("[");
  const start =
    objectIndex < 0
      ? arrayIndex
      : arrayIndex < 0
        ? objectIndex
        : Math.min(objectIndex, arrayIndex);
  if (start < 0) return raw.trim();

  const open = raw[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return raw.slice(start).trim();
}

export function extractJsonContainers(raw: string) {
  const containers: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  const stack: string[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{" || character === "[") {
      if (depth === 0) start = index;
      stack.push(character);
      depth += 1;
      continue;
    }
    if ((character === "}" || character === "]") && depth > 0) {
      const open = stack.at(-1);
      const matched =
        (open === "{" && character === "}") ||
        (open === "[" && character === "]");
      if (!matched) continue;
      stack.pop();
      depth -= 1;
      if (depth === 0 && start >= 0) {
        containers.push(raw.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return [...new Set(containers.map((value) => value.trim()).filter(Boolean))];
}

export function parseStructuredJson<T = unknown>(
  raw: string,
): StructuredJsonParseResult<T> {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("AI 没有返回内容。");

  const candidates = [
    firstJsonContainer(fencedContent(trimmed)),
    firstJsonContainer(trimmed),
    fencedContent(trimmed),
    trimmed,
  ].filter(Boolean);
  const uniqueCandidates = [...new Set(candidates)];

  for (const candidate of uniqueCandidates) {
    try {
      return {
        value: JSON.parse(candidate) as T,
        repaired: false,
      };
    } catch {
      // 继续尝试修复模型常见的非严格 JSON。
    }
  }

  for (const candidate of uniqueCandidates) {
    try {
      return {
        value: JSON.parse(jsonrepair(candidate)) as T,
        repaired: true,
      };
    } catch {
      // 继续尝试下一个候选区块。
    }
  }

  throw new Error(
    "AI 返回内容无法解析为 JSON。请查看原始回答或重新执行匹配。",
  );
}
