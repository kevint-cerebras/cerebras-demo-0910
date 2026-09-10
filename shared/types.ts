export type StoreId = "goodmarket" | "basket" | "daybreak";
export type Diet =
  "vegan" | "vegetarian" | "gluten-free" | "dairy-free" | "nut-free";
export type DeliveryPreference =
  | "earliest"
  | "today"
  | "tomorrow-morning"
  | "tomorrow-afternoon"
  | "tomorrow-evening";
export interface PlanMeta {
  type: "plan";
  title: string;
  people: number;
  budget: number | null;
  diets: Diet[];
  delivery: DeliveryPreference;
  notes: string[];
}
export interface PlanItem {
  type: "item";
  key: string;
  quantity: number;
  reason: string;
}
export interface Plan {
  meta: PlanMeta;
  items: PlanItem[];
}
export interface Product {
  id: string;
  key: string;
  name: string;
  brand: string;
  size: string;
  price: number;
  unit: string;
  color: string;
  art: string;
  diets: Diet[];
  ingredients: string;
  allergens: string[];
  mayContain: string[];
  stock: boolean;
}
export interface Store {
  id: StoreId;
  name: string;
  shortName: string;
  color: string;
  light: string;
  subtitle: string;
  deliveryFee: number;
}
export interface Slot {
  id: string;
  label: string;
  preference: DeliveryPreference;
  fee: number;
  available: boolean;
}
export interface CartItem {
  product: Product;
  quantity: number;
  reason: string;
  checked: boolean;
}
export interface Quote {
  store: StoreId;
  subtotal: number;
  delivery: number;
  total: number;
  complete: boolean;
  missing: string[];
  items: CartItem[];
  slot: Slot | null;
}
export interface TimingSpan {
  name: string;
  category:
    | "navigation"
    | "dom"
    | "browser"
    | "network"
    | "model"
    | "planning"
    | "validation";
  start: number;
  duration: number;
  store?: StoreId;
}
export interface InferenceTiming {
  ttft: number | null;
  firstExecutableAction: number | null;
  generationStream: number | null;
  requestTotal: number | null;
  reasoningEnabled: boolean;
  reasoningTokens: number | null;
  providerQueue: number | null;
  providerPrompt: number | null;
  providerGeneration: number | null;
  providerTotal: number | null;
  transportAndClient: number | null;
}
export interface BrowserWarmup {
  total: number;
  pages: {
    store: StoreId;
    navigation: number;
    ttfb: number;
    domReady: number;
  }[];
}
export interface Metrics {
  browserInferenceCalls?: {
    ttft: number | null;
    firstToolCall: number | null;
    generation: number | null;
    total: number;
    providerQueue: number | null;
    providerPrompt: number | null;
    providerGeneration: number | null;
    providerTotal: number | null;
    reasoningTokens: number | null;
  }[];
  inference?: InferenceTiming;
  warmup?: BrowserWarmup;
  cacheHits?: number;
  actions: number;
  modelCalls: number;
  pages: number;
  total: number;
  firstAction: number | null;
  firstToken: number | null;
  inferenceStart: number | null;
  firstActionAfterToken: number | null;
  networkHeaders: number | null;
  tokens: number | null;
  tokensPerSecond: number | null;
  maxActionGap: number;
  spans: TimingSpan[];
}
export interface BrowserSnapshot {
  store: StoreId;
  html: string;
  url: string;
  cursor: { x: number; y: number } | null;
  label: string;
  at: number;
}
export interface RunEvent {
  seq: number;
  type: string;
  at: number;
  [key: string]: unknown;
}
export interface RunResult {
  id: string;
  status: "approval" | "blocked" | "cancelled" | "error" | "ordered" | "done";
  summary?: string;
  mode: "cerebras" | "local";
  model: string | null;
  plan: Plan;
  quotes: Quote[];
  winner: Quote | null;
  metrics: Metrics;
  warnings: string[];
  receipt?: { id: string; total: number; store: StoreId; slot: string };
}

export interface StoreActivity {
  store: StoreId;
  name: string;
  status: "searching" | "checked" | "cart" | "ready" | "error";
  query?: string;
  productCount?: number;
  total?: number;
}

export interface BrowserTab { id: string; url: string; title: string; active: boolean; work?: "loading" | "reading" | "ready" | "error"; }
