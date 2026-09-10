import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { z } from "zod";
import { catalogKeys, catalogLabels } from "../shared/catalog";
import type { Plan, PlanItem, PlanMeta } from "../shared/types";

export function configuration() {
  let file: Record<string, string> = {};
  try {
    file = parse(readFileSync(".env"));
  } catch {
    /* Environment-only configuration is supported. */
  }
  const key = file.CEREBRAS_API_KEY || process.env.CEREBRAS_API_KEY || "";
  const model = file.CEREBRAS_MODEL || process.env.CEREBRAS_MODEL || "";
  const baseURL = (
    file.CEREBRAS_BASE_URL ||
    process.env.CEREBRAS_BASE_URL ||
    "https://api.cerebras.ai/v1"
  ).replace(/\/$/, "");
  return {
    key,
    model,
    baseURL,
    mode: key && model ? ("cerebras" as const) : ("local" as const),
    incomplete: Boolean(key) !== Boolean(model),
  };
}
const metaSchema = z.object({
  type: z.literal("plan"),
  title: z.string().min(1).max(100),
  people: z.number().int().min(1).max(12),
  budget: z.number().min(1).max(2000).nullable(),
  diets: z
    .array(
      z.enum(["vegan", "vegetarian", "gluten-free", "dairy-free", "nut-free"]),
    )
    .max(5),
  delivery: z.enum([
    "earliest",
    "today",
    "tomorrow-morning",
    "tomorrow-afternoon",
    "tomorrow-evening",
  ]),
  notes: z.array(z.string().max(200)).max(5).default([]),
});
const itemSchema = z.object({
  type: z.literal("item"),
  key: z.enum(catalogKeys as [string, ...string[]]),
  quantity: z.number().int().min(1).max(12),
  reason: z.string().max(160),
});
export function parsePlanLine(line: string): PlanMeta | PlanItem | null {
  const text = line.trim();
  if (!text || text.startsWith("```")) return null;
  const value = JSON.parse(text);
  return value.type === "plan"
    ? metaSchema.parse(value)
    : itemSchema.parse(value);
}
const aliases: Record<string, RegExp> = {
  avocado: /\bavocados?\b/i,
  tomato: /\btomato(?:es)?\b/i,
  tortillas: /\btortillas?\b/i,
  "black-beans": /\bblack beans?\b/i,
  lime: /\blimes?\b/i,
  cilantro: /\bcilantro\b/i,
  onion: /\bonions?\b/i,
  "bell-pepper": /\b(?:bell |sweet )?peppers?\b/i,
  rice: /\brice\b/i,
  tofu: /\btofu\b/i,
  chicken: /\bchicken\b/i,
  salmon: /\bsalmon\b/i,
  pasta: /\b(?:pasta|penne|spaghetti)\b/i,
  "pasta-sauce": /\b(?:pasta sauce|marinara|tomato sauce)\b/i,
  spinach: /\bspinach\b/i,
  mushroom: /\bmushrooms?\b/i,
  garlic: /\bgarlic\b/i,
  "olive-oil": /\bolive oil\b/i,
  cheese: /\b(?:cheese|cheddar)\b/i,
  milk: /(?<!oat )\bmilk\b/i,
  "oat-milk": /\boat milk\b/i,
  eggs: /\beggs?\b/i,
  yogurt: /\byog[uh]?urt\b/i,
  oats: /\b(?:oats|oatmeal)\b/i,
  banana: /\bbananas?\b/i,
  berries: /\b(?:blueberries|berries)\b/i,
  bread: /\b(?:bread|sourdough|toast)\b/i,
  "peanut-butter": /\bpeanut butter\b/i,
  chickpeas: /\b(?:chickpeas|garbanzo)\b/i,
  cucumber: /\bcucumbers?\b/i,
  lettuce: /\b(?:lettuce|romaine)\b/i,
  lemon: /\blemons?\b/i,
  hummus: /\bhummus\b/i,
  quinoa: /\bquinoa\b/i,
  broccoli: /\bbroccoli\b/i,
  "sweet-potato": /\bsweet potatoes?\b/i,
  salsa: /\bsalsa\b/i,
  corn: /\b(?:sweet )?corn\b/i,
  coffee: /\bcoffee\b/i,
  "sparkling-water": /\b(?:sparkling water|seltzer)\b/i,
};
export function mentionedKeys(prompt: string) {
  return Object.entries(aliases)
    .filter(([, re]) => re.test(prompt))
    .map(([key]) => key);
}
export function localPlan(prompt: string): Plan {
  const text = prompt.toLowerCase();
  const unsupported = text.match(
    /\b(?:soy[- ]free|sesame[- ]free|kosher|halal|low[- ]sodium|keto|organic only|diabetic|celiac|coeliac)\b/,
  );
  if (unsupported)
    throw new Error(
      `The local planner cannot verify “${unsupported[0]}”. Connect Cerebras for request interpretation, or try the supported vegan, vegetarian, dairy-free, gluten-free or nut-free examples.`,
    );
  const peopleMatch = text.match(
    /(?:for|feed(?:ing)?)\s+(\d+|one|two|three|four|five|six|eight|ten|twelve)\b/,
  );
  const counts: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    eight: 8,
    ten: 10,
    twelve: 12,
  };
  const people = peopleMatch
    ? counts[peopleMatch[1]] || Number(peopleMatch[1])
    : 2;
  if (people > 12 || people < 1)
    throw new Error(
      "This demo shops for 1–12 people. Try a smaller gathering.",
    );
  const budgetMatch =
    text.match(
      /(?:under|below|budget(?: of)?|less than|up to|max(?:imum)?)\s*\$?\s*(\d+(?:\.\d{1,2})?)/,
    ) || text.match(/\$(\d+(?:\.\d{1,2})?)/);
  const diets: PlanMeta["diets"] = [];
  if (/\bvegan\b/.test(text) && !/\bnot vegan\b/.test(text))
    diets.push("vegan");
  if (/\bvegetarian\b|\bveggie\b/.test(text)) diets.push("vegetarian");
  if (/gluten[ -]free|no gluten|without gluten/.test(text))
    diets.push("gluten-free");
  if (
    /dairy[ -]free|no dairy|without (?:the )?dairy|lactose[ -]free/.test(text)
  )
    diets.push("dairy-free");
  if (/nut[ -]free|no nuts|without nuts|peanut allergy/.test(text))
    diets.push("nut-free");
  const tomorrow = /tomorrow/.test(text);
  const delivery = tomorrow
    ? /morning|breakfast/.test(text.split("tomorrow")[1])
      ? "tomorrow-morning"
      : /afternoon/.test(text.split("tomorrow")[1])
        ? "tomorrow-afternoon"
        : "tomorrow-evening"
    : /today|tonight|asap|as soon/.test(text)
      ? "today"
      : "earliest";
  let title = "Your everyday essentials";
  let recipe: string[] = [];
  if (/\btacos?\b/.test(text)) {
    title = "Taco night, handled";
    recipe = [
      "tortillas",
      "black-beans",
      "avocado",
      "tomato",
      "lime",
      "cilantro",
      "onion",
    ];
    if (/chicken/.test(text)) recipe.push("chicken");
  } else if (
    /\bpasta\b.*(?:dinner|night)|(?:dinner|night).*\bpasta\b/.test(text)
  ) {
    title = "A cozy pasta night";
    recipe = ["pasta", "pasta-sauce", "mushroom", "spinach", "garlic"];
  } else if (/\b(?:breakfast|breakfasts)\b/.test(text)) {
    title = "Mornings, made easy";
    recipe = ["oats", "oat-milk", "banana", "berries", "yogurt"];
  } else if (/\bsalad\b/.test(text)) {
    title = "Something fresh for dinner";
    recipe = ["lettuce", "cucumber", "tomato", "chickpeas", "lemon"];
  } else if (/\b(?:grain|buddha|rice|quinoa) bowls?\b/.test(text)) {
    title = "A good bowl of everything";
    recipe = ["quinoa", "chickpeas", "avocado", "broccoli", "lemon"];
  }
  const keys = [...new Set([...recipe, ...mentionedKeys(prompt)])];
  if (!keys.length)
    throw new Error(
      "Try a grocery list, taco night, a pasta dinner, breakfast, salad or grain bowls. The local planner supports these requests; Cerebras adds broader meal planning.",
    );
  const quantity = Math.max(1, Math.ceil(people / 4));
  const items: PlanItem[] = keys.map((key) => {
    const match = text.match(
      new RegExp(
        `(\\d+)\\s+(?:packs? (?:of )?|packages? (?:of )?)?${key.replace("-", "[ -]")}s?\\b`,
      ),
    );
    return {
      type: "item",
      key,
      quantity: Math.min(
        12,
        match
          ? Math.max(1, Number(match[1]))
          : ["lime", "cilantro", "garlic", "olive-oil", "coffee"].includes(key)
            ? 1
            : key === "black-beans" && recipe.length
              ? Math.ceil(people / 2)
              : quantity,
      ),
      reason: recipe.includes(key)
        ? `For ${title.toLowerCase()}`
        : "On your list",
    };
  });
  if (/\bweek\b/.test(text) && /breakfast/.test(text))
    for (const item of items) {
      if (["banana", "berries", "oat-milk"].includes(item.key))
        item.quantity = Math.max(item.quantity, 2);
    }
  const meta: PlanMeta = {
    type: "plan",
    title,
    people,
    budget: budgetMatch ? Number(budgetMatch[1]) : null,
    diets,
    delivery,
    notes: [
      "Package quantities estimated for your group; pantry salt and pepper assumed on hand.",
    ],
  };
  return { meta: metaSchema.parse(meta), items };
}

// Explicit user limits are enforced independently of the model's interpretation.
export function enforceExplicitConstraints(
  meta: PlanMeta,
  prompt: string,
): PlanMeta {
  const text = prompt.toLowerCase();
  const diets = new Set(meta.diets);
  if (/\bvegan\b/.test(text) && !/\bnot vegan\b/.test(text)) diets.add("vegan");
  if (/\bvegetarian\b|\bveggie\b/.test(text)) diets.add("vegetarian");
  if (
    /dairy[ -]free|no dairy|without (?:the )?dairy|lactose[ -]free/.test(text)
  )
    diets.add("dairy-free");
  if (/gluten[ -]free|no gluten|without gluten/.test(text))
    diets.add("gluten-free");
  if (/nut[ -]free|no nuts|without nuts|(?:peanut|nut) allerg/.test(text))
    diets.add("nut-free");
  const amount =
    text.match(
      /(?:under|below|budget(?: of)?|less than|up to|max(?:imum)?)\s*\$?\s*(\d+(?:\.\d{1,2})?)/,
    ) || text.match(/\$(\d+(?:\.\d{1,2})?)/);
  let budget = meta.budget;
  if (amount)
    budget =
      budget === null ? Number(amount[1]) : Math.min(budget, Number(amount[1]));
  return { ...meta, diets: [...diets], budget };
}

interface StreamCallbacks {
  onLine: (line: PlanMeta | PlanItem) => void;
  onFirstToken: () => void;
  onHeaders: () => void;
  onUsage: (tokens: number, reasoningTokens: number | null) => void;
  onContent: () => void;
  onProviderTiming: (timing: {
    queue_time?: number;
    prompt_time?: number;
    completion_time?: number;
    total_time?: number;
  }) => void;
}
export async function streamCerebrasPlan(
  prompt: string,
  callbacks: StreamCallbacks,
  signal: AbortSignal,
) {
  const config = configuration();
  const system = `You plan groceries for a fast browser shopping demo. Output ONLY newline-delimited JSON. Each complete line is immediately executed. No markdown, reasoning, prose or blank preamble. First line MUST be a plan object. Then 1-16 unique item lines. No URLs, selectors, code or purchase commands.
First line schema: {"type":"plan","title":"Short friendly title","people":2,"budget":null,"diets":[],"delivery":"earliest","notes":[]}
budget is a dollar amount or null. people 1-12. diets only vegan, vegetarian, gluten-free, dairy-free, nut-free. delivery only earliest, today, tomorrow-morning, tomorrow-afternoon, tomorrow-evening. Apply all constraints. notes must explicitly identify requests this catalog cannot satisfy or verify, prefixed with "UNSUPPORTED:". Only flag a concrete requirement explicitly present in the user request. Quote the exact unmet user words. Supported vegan milk, cheese and yogurt are normal items, not unsupported requests. Never invent a brand requirement. If no brand was requested, do not discuss brands. Never silently drop a requested item, allergy or constraint. Budget limits and all supported dietary restrictions are FULLY SUPPORTED by downstream browser code. Never flag price verification, budget, stock, or the supported delivery windows as UNSUPPORTED. The browser reads actual prices and enforces the budget after your plan. Do not add caveats about prices or availability. Do not claim dietary compliance; browser checks labels. Do not invent availability or prices. For simple supported requests, notes should be empty or a single pantry assumption.
Item schema: {"type":"item","key":"catalog-key","quantity":1,"reason":"Short purpose"}
quantity is number of packages, 1-12. Plan appropriate quantities for servings. Assume salt and pepper on hand. One 16oz pasta pack feeds 4; one dozen tortilla pack feeds 4; one bean can feeds 2; one avocado pack contains 2. Only use these catalog keys: ${catalogKeys.map((k) => `${k} (${catalogLabels[k]})`).join(", ")}.
Compose sensible meals if requested. Dairy-free/vegan cheese, yogurt and milk alternatives and gluten-free pasta/bread are fully supported within their same categories. Example request "Vegan milk, cheese and yogurt under $30 tomorrow morning" produces a normal plan with diets ["vegan"], budget 30, delivery "tomorrow-morning", notes [], and three item lines for milk, cheese, yogurt. For vegan meals prefer beans/tofu instead of meat. Do not substitute unrelated products. For a wholly unrelated task output a plan with an UNSUPPORTED note and no items. Stream the plan and first items as quickly as possible.`;
  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      reasoning_effort: "none",
      max_completion_tokens: 1800,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  });
  callbacks.onHeaders();
  if (!response.ok) {
    // Never echo provider bodies, which can include echoed request data or credentials.
    await response.body?.cancel();
    throw new Error(
      `Cerebras returned HTTP ${response.status}. Check the API key, exact model ID and account access in .env.`,
    );
  }
  if (!response.body)
    throw new Error("Cerebras did not return a response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "",
    lineBuffer = "",
    first = true,
    done = false,
    receivedPlan = false,
    itemCount = 0;
  const parseLine = (raw: string) => {
    const line = parsePlanLine(raw);
    if (!line) return;
    if (line.type === "plan") {
      if (receivedPlan || itemCount)
        throw new Error(
          "The model returned a second or late plan. Please retry.",
        );
      receivedPlan = true;
    } else {
      if (!receivedPlan)
        throw new Error(
          "The model streamed an item before the shopping constraints. Please retry.",
        );
      if (++itemCount > 16)
        throw new Error(
          "The model exceeded the 16-item demo limit. Try a shorter list.",
        );
    }
    callbacks.onLine(line);
  };
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      sseBuffer += decoder
        .decode(chunk.value, { stream: true })
        .replace(/\r/g, "");
      let boundary: number;
      while ((boundary = sseBuffer.indexOf("\n\n")) !== -1) {
        const event = sseBuffer.slice(0, boundary);
        sseBuffer = sseBuffer.slice(boundary + 2);
        const data = event
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        if (data === "[DONE]") {
          done = true;
          break;
        }
        const parsed = JSON.parse(data);
        if (parsed.error)
          throw new Error("Cerebras reported a streaming error. Please retry.");
        if (typeof parsed.usage?.completion_tokens === "number")
          callbacks.onUsage(
            parsed.usage.completion_tokens,
            parsed.usage.completion_tokens_details?.reasoning_tokens ?? null,
          );
        if (parsed.time_info) callbacks.onProviderTiming(parsed.time_info);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta !== "string" || !delta) continue;
        if (first) {
          first = false;
          callbacks.onFirstToken();
        }
        callbacks.onContent();
        lineBuffer += delta;
        while (lineBuffer.includes("\n")) {
          const end = lineBuffer.indexOf("\n");
          const line = lineBuffer.slice(0, end);
          lineBuffer = lineBuffer.slice(end + 1);
          parseLine(line);
        }
      }
    }
    if (lineBuffer.trim()) parseLine(lineBuffer);
    if (!receivedPlan)
      throw new Error(
        "The model did not return a valid shopping plan. Please retry.",
      );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
