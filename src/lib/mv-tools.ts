import { sanitizeUserText } from "./mv-security";

export type Product = {
  id: string;
  title: string;
  price: number;
  oldPrice?: number;
  rating: number;
  reviews: number;
  image: string;
  url: string;
  stock: { warehouse: number; store: number; storeName: string };
  margin?: number;
  category: string;
};

export type BlogArticle = {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  contentChars?: number;
  contentSource?: "wordpress" | "html";
  score?: number;
  relevance?: string;
};

export type ReviewSummary = {
  productId: string;
  totalNumber: number;
  recommendPercent: number;
  totalRating: number;
  snippets: string[];
  benefits: string[];
  drawbacks: string[];
};

export type BlogSource = {
  title: string;
  url: string;
};

export const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "search_catalog",
      description:
        "Поиск товаров в реальном публичном каталоге М.Видео. Сначала пойми, какой тип товара нужен пользователю, и ищи именно его, а сценарий использования передавай как критерии. Если нужно отсечь нерелевантную выдачу, укажи requiredTerms/excludedTerms.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "Короткий каталожный запрос: тип товара + главные характеристики",
          },
          requiredTerms: {
            type: "array",
            items: { type: "string" },
            description: "Слова, которые должны быть в названии или категории товара",
          },
          excludedTerms: {
            type: "array",
            items: { type: "string" },
            description: "Слова, которых не должно быть в названии или категории товара",
          },
          minPrice: {
            type: "number",
            description: "Минимальная цена в рублях, если пользователь указал бюджет снизу",
          },
          maxPrice: {
            type: "number",
            description: "Максимальная цена в рублях, если пользователь указал бюджет сверху",
          },
          offset: {
            type: "number",
            description: "Смещение выдачи для чтения следующей страницы каталога, начиная с 0",
          },
          limit: {
            type: "number",
            description: "Сколько товаров прочитать за вызов, от 1 до 36. Обычно 12-24",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_reviews",
      description:
        "Получает реальные отзывы покупателей М.Видео по productId из search_catalog или по короткому запросу. Используй для обоснования рекомендаций конкретных товаров: плюсы, минусы, рейтинг, процент рекомендаций. Не используй URL товара как Источник.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          productId: { type: "string", description: "ID товара из search_catalog" },
          query: { type: "string", description: "Запрос, если productId ещё неизвестен" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "recommend_products",
      description:
        "Явно отмечает товары, которые ассистент решил рекомендовать после поиска каталога, чтения статей и/или отзывов. Вызывай только в конце анализа и только для productIds из search_catalog, которые соответствуют исходному типу товара. Если пользователь ищет OLED для игр как телевизор, не передавай консоли Nintendo/Steam Deck. Если рекомендовать нечего — не вызывай.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          productIds: {
            type: "array",
            items: { type: "string" },
            description: "ID товаров из результатов search_catalog, выбранных ассистентом",
          },
        },
        required: ["productIds"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_blog",
      description:
        "Поиск технических статей и обзоров в реальном публичном блоге mvideo.ru/blog/. Передавай отдельный тематический запрос для статьи, например: 'как выбрать HDMI кабель' или 'саундбар Dolby Atmos'. Инструмент возвращает несколько кандидатов; выбери источник сам и используй только статью, которая действительно объясняет критерии выбора или выбранный тип товара.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string", description: "Тема для поиска" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cite_blog_source",
      description:
        "Структурно выбирает статью блога М.Видео как источник обоснования. Обязательно вызови этот tool перед финальным ответом, если используешь факты, идеи или критерии из search_blog/article.content. Не пиши строку 'Источник:' текстом — источник установит этот tool.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "Точный title статьи из search_blog" },
          url: { type: "string", description: "Точный url статьи из search_blog" },
        },
        required: ["title", "url"],
      },
    },
  },
];

type CatalogPage = { offset: number; limit: number; total?: number; nextOffset?: number };

type ToolResult =
  | {
      products: Product[];
      source: "live";
      role?: "catalog" | "recommendation";
      page?: CatalogPage;
    }
  | { reviews: ReviewSummary[]; source: "live" }
  | ({
      article: BlogArticle;
      articles: BlogArticle[];
      title: string;
      url: string;
      snippet: string;
    } & { source: "live" })
  | { citation: BlogSource; source: "selected" }
  | { error: string };

type MvideoSearchResponse = {
  success?: boolean;
  body?: {
    total?: number;
    products?: string[];
  };
  errors?: string[];
};

type MvideoDetail = {
  productId?: string;
  name?: string;
  nameTranslit?: string;
  image?: string;
  images?: string[];
  brandName?: string;
  category?: { id?: string; name?: string };
  rating?: { star?: number; count?: number };
  status?: { soldOut?: boolean; availableOnlyInRetailStore?: boolean };
  propertiesPortion?: Array<{ name?: string; value?: string }>;
};

type MvideoDetailsResponse = {
  success?: boolean;
  body?: { products?: MvideoDetail[] };
  errors?: string[];
};

type MvideoPrice = {
  productId?: string;
  price?: { basePrice?: number; salePrice?: number; basePromoPrice?: number };
};

type MvideoPricesResponse = {
  success?: boolean;
  body?: { materialPrices?: MvideoPrice[] };
  errors?: string[];
};

type MvideoReviewsResponse = {
  success?: boolean;
  body?: {
    totalNumber?: number;
    recommendPercent?: number;
    totalRating?: number;
    reviews?: Array<{
      text?: string;
      benefits?: string;
      drawbacks?: string;
      score?: number;
      recommendation?: boolean;
    }>;
  };
};

type WordpressSearchItem = {
  id?: number;
  title?: string;
  url?: string;
  type?: string;
  subtype?: string;
};

type WordpressPostItem = {
  link?: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  content?: { rendered?: string };
};

type CacheEntry<T> = { value: T; expiresAt: number };

const MVIDEO_ORIGIN = "https://www.mvideo.ru";
const MVIDEO_IMAGE_ORIGIN = "https://img.mvideo.ru";
const REQUEST_TIMEOUT_MS = 9000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const BLOG_ARTICLE_CONTENT_LIMIT = 4_000;
const BLOG_STOP_WORDS = new Set([
  "для",
  "или",
  "при",
  "что",
  "как",
  "это",
  "есть",
  "нужен",
  "нужна",
  "нужно",
  "выбрать",
  "мвидео",
]);
const BLOG_CATEGORY_WORDS = new Set([
  "hdmi",
  "кабель",
  "саундбар",
  "soundbar",
  "dolby",
  "atmos",
  "телевизор",
  "монитор",
  "ps5",
  "oled",
  "наушники",
  "ноутбук",
  "смартфон",
  "кофеварка",
  "кофемашина",
  "кофемолка",
]);
const CATALOG_INTENT_STOP_WORDS = new Set([
  "какой",
  "какая",
  "какое",
  "какие",
  "подбери",
  "найди",
  "посоветуй",
  "нужен",
  "нужна",
  "нужно",
  "хочу",
  "лучший",
  "лучшие",
]);
const cache = new Map<string, CacheEntry<unknown>>();
let mvideoCookieHeader = "";
let mvideoCookieExpiresAt = 0;
let blogCookieHeader = "";
let blogCookieExpiresAt = 0;

const MVIDEO_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
  "user-agent":
    "Mozilla/5.0 (Linux; Android 10; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  referer: `${MVIDEO_ORIGIN}/`,
  "x-set-application-id": "ea45c09a-880c-4b8e-a822-836dabb8988e",
  cookie: [
    "MVID_CITY_ID=CityR_32",
    "MVID_REGION_ID=1",
    "MVID_REGION_SHOP=S002",
    "MVID_KLADR_ID=7700000000000",
    "MVID_TIMEZONE_OFFSET=3",
    "MVID_CATALOG_STATE=1",
    "MVID_WEBP_ENABLED=true",
    "MVID_ENVCLOUD=prod2",
    "deviceType=desktop",
    "searchType2=2",
  ].join("; "),
};

export async function runTool(
  name: string,
  args: {
    query?: string;
    productId?: string;
    productIds?: string[];
    requiredTerms?: string[];
    excludedTerms?: string[];
    minPrice?: number;
    maxPrice?: number;
    offset?: number;
    limit?: number;
    title?: string;
    url?: string;
  },
): Promise<ToolResult> {
  const query = sanitizeUserText(args?.query || "", 240);
  const productId = sanitizeUserText(args?.productId || "", 40);
  const sourceTitle = sanitizeUserText(args?.title || "", 180);
  const sourceUrl = sanitizeBlogSourceUrl(args?.url);
  const productIds = sanitizeProductIds(args?.productIds);
  const requiredTerms = sanitizeTerms(args?.requiredTerms);
  const excludedTerms = sanitizeTerms(args?.excludedTerms);
  const minPrice = sanitizeOptionalMoney(args?.minPrice);
  const maxPrice = sanitizeOptionalMoney(args?.maxPrice);
  const offset = sanitizeCatalogOffset(args?.offset);
  const limit = sanitizeCatalogLimit(args?.limit);
  if (!query && !productId && !productIds.length && !(sourceTitle && sourceUrl)) {
    return { error: "empty query" };
  }

  if (name === "search_catalog") {
    const catalog = await searchCatalogLive(query, {
      requiredTerms,
      excludedTerms,
      minPrice,
      maxPrice,
      offset,
      limit,
    });
    if (!catalog.products.length) {
      return {
        error:
          "Не удалось получить товары из реального публичного каталога М.Видео: BFF каталога не вернул данные или заблокировал запрос.",
      };
    }
    return { products: catalog.products, page: catalog.page, source: "live", role: "catalog" };
  }

  if (name === "recommend_products") {
    const products = await fetchProductsByIds(productIds);
    if (!products.length) return { error: "Не удалось подтвердить выбранные товары М.Видео." };
    return { products, source: "live", role: "recommendation" };
  }

  if (name === "search_reviews") {
    const reviews = await searchReviewsLive({ productId, query });
    if (!reviews.length) {
      return { error: "Не удалось получить релевантные отзывы покупателей М.Видео." };
    }
    return { reviews, source: "live" };
  }

  if (name === "search_blog") {
    const articles = await searchBlogLive(query);
    const article = articles[0];
    if (!article) {
      return {
        error: "Не удалось получить релевантную статью из реального публичного блога М.Видео.",
      };
    }
    return {
      article,
      articles: articles.map(summarizeBlogArticleForList),
      title: article.title,
      url: article.url,
      snippet: article.snippet,
      source: "live",
    };
  }

  if (name === "cite_blog_source") {
    if (!sourceTitle || !sourceUrl) return { error: "invalid source" };
    return { citation: { title: sourceTitle, url: sourceUrl }, source: "selected" };
  }

  return { error: "unknown tool" };
}

async function fetchProductsByIds(productIds: string[]): Promise<Product[]> {
  if (!productIds.length) return [];
  const [details, prices] = await Promise.all([
    fetchProductDetails(productIds),
    fetchProductPrices(productIds),
  ]);
  const priceById = new Map(prices.map((item) => [String(item.productId || ""), item]));
  return details
    .map((detail) => toProductFromMvideo(detail, priceById.get(String(detail.productId || ""))))
    .filter((product): product is Product => Boolean(product));
}

async function searchCatalogLive(
  query: string,
  constraints: {
    requiredTerms: string[];
    excludedTerms: string[];
    minPrice?: number;
    maxPrice?: number;
    offset?: number;
    limit?: number;
  } = {
    requiredTerms: [],
    excludedTerms: [],
  },
): Promise<{ products: Product[]; page: CatalogPage }> {
  const intent = normalizeCatalogIntent(query, constraints);
  const effectiveConstraints = {
    requiredTerms: intent.constraints.requiredTerms.length
      ? intent.constraints.requiredTerms
      : inferRequiredTerms(intent.query),
    excludedTerms: intent.constraints.excludedTerms,
    minPrice: constraints.minPrice,
    maxPrice: constraints.maxPrice,
  };
  const page = { offset: constraints.offset ?? 0, limit: constraints.limit ?? 24 };

  return cached(
    `catalog:${intent.query.toLowerCase()}:${effectiveConstraints.requiredTerms.join(",")}:${effectiveConstraints.excludedTerms.join(",")}:${effectiveConstraints.minPrice || ""}:${effectiveConstraints.maxPrice || ""}:${page.offset}:${page.limit}`,
    async () => {
      const direct = await searchCatalogOnce(intent.query, effectiveConstraints, page);
      if (direct.products.length || !effectiveConstraints.requiredTerms.length) return direct;

      return searchCatalogOnce(
        effectiveConstraints.requiredTerms.join(" "),
        effectiveConstraints,
        page,
      );
    },
  );
}

function normalizeCatalogIntent(
  query: string,
  constraints: { requiredTerms: string[]; excludedTerms: string[] },
): { query: string; constraints: { requiredTerms: string[]; excludedTerms: string[] } } {
  const normalized = query.replace(/\s+/g, " ").trim();
  if (!isAmbiguousDisplayGamingIntent(normalized)) {
    return { query: normalized, constraints };
  }

  return {
    query: buildDisplayGamingQuery(normalized),
    constraints: {
      requiredTerms: mergeTerms(constraints.requiredTerms, displayGamingRequiredTerms(normalized)),
      excludedTerms: mergeTerms(constraints.excludedTerms, [
        "консоль",
        "steam",
        "deck",
        "nintendo",
        "switch",
      ]),
    },
  };
}

function isAmbiguousDisplayGamingIntent(query: string): boolean {
  const lower = query.toLowerCase();
  const hasDisplayTech = /\boled\b|mini\s*led|qled|120\s*гц|hdmi\s*2\.?1|vrr/u.test(lower);
  const hasGameScenario = /игр|гейм|ps5|playstation|xbox|консол/u.test(lower);
  const hasExplicitType =
    /телевизор|\bтв\b|\btv\b|монитор|ноутбук|смартфон|телефон|консоль|пристав|steam|deck|nintendo|switch|планшет/u.test(
      lower,
    );
  return hasDisplayTech && hasGameScenario && !hasExplicitType;
}

function buildDisplayGamingQuery(query: string): string {
  const lower = query.toLowerCase();
  if (/\boled\b/u.test(lower)) return "OLED телевизор для игр";
  if (/mini\s*led/u.test(lower)) return "Mini LED телевизор для игр";
  if (/qled/u.test(lower)) return "QLED телевизор для игр";
  return "телевизор 120 Гц HDMI 2.1";
}

function displayGamingRequiredTerms(query: string): string[] {
  const lower = query.toLowerCase();
  if (/\boled\b/u.test(lower)) return ["телевизор", "oled"];
  if (/mini\s*led/u.test(lower)) return ["телевизор", "mini"];
  if (/qled/u.test(lower)) return ["телевизор", "qled"];
  return ["телевизор"];
}

function mergeTerms(current: string[], extra: string[]): string[] {
  return [...new Set([...current, ...extra].map((term) => term.toLowerCase()))].slice(0, 8);
}

async function searchCatalogOnce(
  query: string,
  constraints: {
    requiredTerms: string[];
    excludedTerms: string[];
    minPrice?: number;
    maxPrice?: number;
  },
  page: { offset: number; limit: number },
): Promise<{ products: Product[]; page: CatalogPage }> {
  const search = await fetchSearchProductIds(query, page.offset, page.limit);
  if (!search.ids.length) return { products: [], page: { ...page, total: search.total } };

  const [details, prices] = await Promise.all([
    fetchProductDetails(search.ids),
    fetchProductPrices(search.ids),
  ]);
  const priceById = new Map(prices.map((item) => [String(item.productId || ""), item]));
  const products = details
    .map((detail) => toProductFromMvideo(detail, priceById.get(String(detail.productId || ""))))
    .filter((product): product is Product => Boolean(product));
  const filtered = dedupeProductsForTool(filterProductsByTerms(products, constraints));
  const nextOffset =
    typeof search.total === "number" && page.offset + page.limit < search.total
      ? page.offset + page.limit
      : undefined;

  return { products: filtered, page: { ...page, total: search.total, nextOffset } };
}

function inferRequiredTerms(query: string): string[] {
  const match = query
    .toLowerCase()
    .replace(/[?!.,:;]+/g, " ")
    .match(/^(.+?)\s+(?:для|под|к|ко|совместим(?:ый|ая|ое|ые)?\s+с)\s+.+$/u);
  if (!match) return [];

  const terms = match[1]
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !CATALOG_INTENT_STOP_WORDS.has(word));
  return terms.slice(-2);
}

function filterProductsByTerms(
  products: Product[],
  constraints: {
    requiredTerms: string[];
    excludedTerms: string[];
    minPrice?: number;
    maxPrice?: number;
  },
): Product[] {
  return products.filter((product) => {
    const text = `${product.title} ${product.category}`.toLowerCase();
    const price = product.price || 0;
    return (
      constraints.requiredTerms.every((term) => text.includes(term.toLowerCase())) &&
      constraints.excludedTerms.every((term) => !text.includes(term.toLowerCase())) &&
      (constraints.minPrice === undefined || price >= constraints.minPrice) &&
      (constraints.maxPrice === undefined || price <= constraints.maxPrice)
    );
  });
}

function sanitizeOptionalMoney(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.min(Math.floor(number), 10_000_000);
}

function sanitizeCatalogOffset(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.floor(number), 1000);
}

function sanitizeCatalogLimit(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 24;
  return Math.min(Math.max(Math.floor(number), 1), 36);
}

function sanitizeProductIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.map((item) => sanitizeUserText(String(item || ""), 40)).filter(Boolean)),
  ].slice(0, 8);
}

function sanitizeTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => sanitizeUserText(String(item || ""), 40).toLowerCase())
    .filter((item) => item.length > 1)
    .slice(0, 5);
}

function sanitizeBlogSourceUrl(value: unknown): string {
  const raw = sanitizeUserText(String(value || ""), 400);
  if (!raw) return "";
  try {
    const url = new URL(raw, MVIDEO_ORIGIN);
    if (url.protocol !== "https:" || url.hostname !== "www.mvideo.ru") return "";
    if (!url.pathname.startsWith("/blog/")) return "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

async function searchReviewsLive(input: {
  productId?: string;
  query?: string;
}): Promise<ReviewSummary[]> {
  const productIds = input.productId
    ? [input.productId]
    : (await searchCatalogLive(input.query || "")).products
        .slice(0, 3)
        .map((product) => product.id);

  const reviews = await Promise.all(productIds.map((productId) => fetchProductReviews(productId)));
  return reviews.filter((review): review is ReviewSummary => Boolean(review));
}

async function fetchProductReviews(productId: string): Promise<ReviewSummary | null> {
  const url = `${MVIDEO_ORIGIN}/bff/reviews/aplaut?context=product&contextId=${encodeURIComponent(
    productId,
  )}&sort=helpfulness%3Adesc&perPage=5`;
  const data = await fetchJson<MvideoReviewsResponse>(url, {
    headers: await mvideoRequestHeaders("application/json, text/plain, */*"),
  });
  const body = data?.body;
  const rawReviews = body?.reviews || [];
  if (!body || !rawReviews.length) return null;

  return {
    productId,
    totalNumber: numberOrZero(body.totalNumber),
    recommendPercent: numberOrZero(body.recommendPercent),
    totalRating: numberOrZero(body.totalRating),
    snippets: rawReviews
      .map((review) => stripTags(review.text || ""))
      .filter(Boolean)
      .slice(0, 3),
    benefits: rawReviews
      .map((review) => stripTags(review.benefits || ""))
      .filter(Boolean)
      .slice(0, 3),
    drawbacks: rawReviews
      .map((review) => stripTags(review.drawbacks || ""))
      .filter(Boolean)
      .slice(0, 3),
  };
}

function dedupeProductsForTool(products: Product[]): Product[] {
  const seen = new Set<string>();
  return products.filter((product) => {
    const key = product.title.toLowerCase().replace(/\s+/g, " ").trim() || product.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchSearchProductIds(
  query: string,
  offset = 0,
  limit = 24,
): Promise<{ ids: string[]; total?: number }> {
  const url = `${MVIDEO_ORIGIN}/bff/products/v2/search?query=${encodeURIComponent(
    query,
  )}&offset=${offset}&limit=${limit}`;
  const data = await fetchJson<MvideoSearchResponse>(url, {
    headers: await mvideoRequestHeaders("application/json, text/plain, */*"),
  });
  const products = data?.body?.products;
  if (!Array.isArray(products)) return { ids: [], total: data?.body?.total };
  return {
    ids: [...new Set(products.map(String).filter(Boolean))],
    total: data?.body?.total,
  };
}

async function fetchProductDetails(productIds: string[]): Promise<MvideoDetail[]> {
  if (!productIds.length) return [];
  const data = await fetchJson<MvideoDetailsResponse>(`${MVIDEO_ORIGIN}/bff/product-details/list`, {
    method: "POST",
    headers: {
      ...(await mvideoRequestHeaders("application/json, text/plain, */*")),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      productIds,
      mediaTypes: ["images"],
      category: true,
      status: true,
      brand: true,
      propertyTypes: ["KEY"],
      propertiesConfig: { propertiesPortionSize: 6 },
      multioffer: false,
    }),
  });
  return Array.isArray(data?.body?.products) ? data.body.products : [];
}

async function fetchProductPrices(productIds: string[]): Promise<MvideoPrice[]> {
  if (!productIds.length) return [];
  const url = `${MVIDEO_ORIGIN}/bff/products/prices?productIds=${encodeURIComponent(
    productIds.join(","),
  )}&addBonusRubles=true&isPromoApplied=true`;
  const data = await fetchJson<MvideoPricesResponse>(url, {
    headers: await mvideoRequestHeaders("application/json, text/plain, */*"),
  });
  return Array.isArray(data?.body?.materialPrices) ? data.body.materialPrices : [];
}

async function mvideoRequestHeaders(accept: string): Promise<Record<string, string>> {
  const cookie = [MVIDEO_HEADERS.cookie, await getMvideoCookieHeader()].filter(Boolean).join("; ");
  return { ...MVIDEO_HEADERS, accept, cookie };
}

async function getMvideoCookieHeader(): Promise<string> {
  const now = Date.now();
  if (mvideoCookieHeader && mvideoCookieExpiresAt > now) return mvideoCookieHeader;

  try {
    const res = await fetch(`${MVIDEO_ORIGIN}/product-list-page?q=ps5`, {
      redirect: "manual",
      headers: { ...MVIDEO_HEADERS, accept: "text/html,application/xhtml+xml,*/*" },
    });
    mvideoCookieHeader = extractCookieHeader(res);
    mvideoCookieExpiresAt = now + 25 * 60 * 1000;
  } catch {
    mvideoCookieHeader = "";
    mvideoCookieExpiresAt = now + 60_000;
  }

  return mvideoCookieHeader;
}

function extractCookieHeader(res: Response): string {
  const headersWithCookies = res.headers as Headers & { getSetCookie?: () => string[] };
  return (headersWithCookies.getSetCookie?.() || [res.headers.get("set-cookie") || ""])
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T | null> {
  const text = await fetchText(url, init);
  if (!text) return null;
  if (isPoisonPill(text)) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function fetchText(url: string, init: RequestInit = {}): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok && text.length < 10_000) return null;
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function searchBlogLive(query: string): Promise<BlogArticle[]> {
  return cached(`blog:${query.toLowerCase()}`, async () => {
    const variants = blogQueryVariants(query);
    const apiArticles = (
      await Promise.all([
        ...variants.map((variant) => fetchBlogSearchApi(variant)),
        ...variants.map((variant) => fetchBlogPostsApi(variant)),
      ])
    ).flat();

    const apiCandidates = rankRelevantBlogArticles(apiArticles, query);
    if (apiCandidates.length) return hydrateTopBlogArticles(apiCandidates, 1);

    const pages = await Promise.all(
      [
        `${MVIDEO_ORIGIN}/blog/category/pomogaem-razobratsya`,
        `${MVIDEO_ORIGIN}/blog/category/obzory`,
        `${MVIDEO_ORIGIN}/blog/category/podborki`,
      ].map((url) => fetchBlogHtml(url)),
    );
    const htmlCandidates = rankRelevantBlogArticles(
      pages.flatMap((html) => (html ? extractBlogArticles(html) : [])),
      query,
    );
    return hydrateTopBlogArticles(htmlCandidates, 1);
  });
}

async function hydrateTopBlogArticles(
  articles: BlogArticle[],
  count: number,
): Promise<BlogArticle[]> {
  if (!articles.length || count <= 0) return articles;
  const hydrated = await Promise.all(
    articles.slice(0, count).map((article) => hydrateBlogArticle(article)),
  );
  return [...hydrated, ...articles.slice(count)];
}

async function hydrateBlogArticle(article: BlogArticle): Promise<BlogArticle> {
  if (article.content && article.content.length >= 300) return article;

  const fromApi = await fetchBlogArticleContentFromApi(article.url);
  if (fromApi?.content) return { ...article, ...fromApi };

  const fromHtml = await fetchBlogArticleContentFromHtml(article.url);
  if (fromHtml?.content) return { ...article, ...fromHtml };

  return article;
}

async function fetchBlogArticleContentFromApi(
  articleUrl: string,
): Promise<Pick<BlogArticle, "content" | "contentChars" | "contentSource"> | null> {
  const slug = blogSlugFromUrl(articleUrl);
  if (!slug) return null;

  const url = `${MVIDEO_ORIGIN}/blog/wp-json/wp/v2/posts?slug=${encodeURIComponent(
    slug,
  )}&per_page=1&_fields=link,title,excerpt,content`;
  const items = await fetchJson<WordpressPostItem[]>(url, {
    headers: await blogRequestHeaders("application/json"),
  });
  const item = Array.isArray(items) ? items[0] : undefined;
  return blogArticleContentFromHtml(item?.content?.rendered || "", "wordpress");
}

async function fetchBlogArticleContentFromHtml(
  articleUrl: string,
): Promise<Pick<BlogArticle, "content" | "contentChars" | "contentSource"> | null> {
  const html = await fetchBlogHtml(articleUrl);
  if (!html) return null;
  return blogArticleContentFromHtml(extractMainArticleHtml(html), "html");
}

function summarizeBlogArticleForList(article: BlogArticle): BlogArticle {
  const { content: _content, ...summary } = article;
  return summary;
}

function blogArticleContentFromHtml(
  html: string,
  source: "wordpress" | "html",
): Pick<BlogArticle, "content" | "contentChars" | "contentSource"> | null {
  const content = normalizeArticleText(stripTags(html));
  if (content.length < 300) return null;
  return {
    content: limitArticleContent(content),
    contentChars: content.length,
    contentSource: source,
  };
}

function extractMainArticleHtml(html: string): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  const article = cleaned.match(/<article\b[\s\S]*?<\/article>/i)?.[0];
  if (article) return article;
  const main = cleaned.match(/<main\b[\s\S]*?<\/main>/i)?.[0];
  return main || cleaned;
}

function normalizeArticleText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/Читайте также[:\s].*$/i, "")
    .trim();
}

function limitArticleContent(text: string): string {
  if (text.length <= BLOG_ARTICLE_CONTENT_LIMIT) return text;
  const cut = text.slice(0, BLOG_ARTICLE_CONTENT_LIMIT);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), BLOG_ARTICLE_CONTENT_LIMIT - 200)).trim()}…`;
}

function blogSlugFromUrl(articleUrl: string): string {
  try {
    const url = new URL(articleUrl, MVIDEO_ORIGIN);
    return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
  } catch {
    return "";
  }
}

async function fetchBlogSearchApi(query: string): Promise<BlogArticle[]> {
  const url = `${MVIDEO_ORIGIN}/blog/wp-json/wp/v2/search?search=${encodeURIComponent(
    query,
  )}&per_page=8`;
  const items = await fetchJson<WordpressSearchItem[]>(url, {
    headers: await blogRequestHeaders("application/json"),
  });
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item.subtype === "post" && item.url && item.title)
    .map((item) => ({
      title: stripTags(item.title || ""),
      url: absolutizeMvideoUrl(item.url || "").replace(/\?.*$/, ""),
      snippet: stripTags(item.title || ""),
    }));
}

async function fetchBlogPostsApi(query: string): Promise<BlogArticle[]> {
  const url = `${MVIDEO_ORIGIN}/blog/wp-json/wp/v2/posts?search=${encodeURIComponent(
    query,
  )}&per_page=8&_fields=link,title,excerpt`;
  const items = await fetchJson<WordpressPostItem[]>(url, {
    headers: await blogRequestHeaders("application/json"),
  });
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item.link && item.title?.rendered)
    .map((item) => ({
      title: stripTags(item.title?.rendered || ""),
      url: absolutizeMvideoUrl(item.link || "").replace(/\?.*$/, ""),
      snippet: stripTags(item.excerpt?.rendered || item.title?.rendered || "").slice(0, 260),
    }));
}

async function fetchBlogHtml(url: string): Promise<string | null> {
  return fetchText(url, {
    headers: await blogRequestHeaders(
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    ),
  });
}

async function blogRequestHeaders(accept: string): Promise<Record<string, string>> {
  const cookie = [MVIDEO_HEADERS.cookie, await getBlogCookieHeader()].filter(Boolean).join("; ");
  return {
    ...MVIDEO_HEADERS,
    accept,
    referer: `${MVIDEO_ORIGIN}/blog`,
    cookie,
  };
}

async function getBlogCookieHeader(): Promise<string> {
  const now = Date.now();
  if (blogCookieHeader && blogCookieExpiresAt > now) return blogCookieHeader;

  try {
    const res = await fetch(`${MVIDEO_ORIGIN}/blog`, {
      redirect: "manual",
      headers: {
        ...MVIDEO_HEADERS,
        accept: "text/html,application/xhtml+xml,*/*",
        referer: `${MVIDEO_ORIGIN}/blog`,
      },
    });
    blogCookieHeader = extractCookieHeader(res);
    blogCookieExpiresAt = now + 25 * 60 * 1000;
  } catch {
    blogCookieHeader = "";
    blogCookieExpiresAt = now + 60_000;
  }

  return blogCookieHeader;
}

function extractBlogArticles(html: string): BlogArticle[] {
  const linkRe =
    /<a[^>]+href=["']([^"']*\/blog\/(?!category|\?)[^"'#?]+(?:[?#][^"']*)?)["'][^>]*>([\s\S]{8,900}?)<\/a>/gi;
  const seen = new Set<string>();
  const articles: BlogArticle[] = [];
  let match: RegExpExecArray | null;

  while ((match = linkRe.exec(html))) {
    const url = absolutizeMvideoUrl(match[1]).replace(/\?.*$/, "");
    const title = stripTags(match[2]);
    if (seen.has(url) || title.length < 12 || /^(читать|подробнее|м\.клик)$/i.test(title)) continue;
    seen.add(url);
    articles.push({ title, url, snippet: findNearbyText(html, match.index, 260) || title });
  }

  return articles;
}

function blogQueryVariants(query: string): string[] {
  const normalizedQuery = isAmbiguousDisplayGamingIntent(query)
    ? buildDisplayGamingQuery(query)
    : query;
  const words = normalizeWords(normalizedQuery).filter((word) => !BLOG_STOP_WORDS.has(word));
  const variants = [normalizedQuery.trim()];
  if (query.trim() !== normalizedQuery.trim()) variants.push(query.trim());
  if (words.length) variants.push(words.join(" "));

  const categoryWords = words.filter((word) => BLOG_CATEGORY_WORDS.has(word));
  if (categoryWords.length) variants.push(categoryWords.join(" "));
  if (words.includes("hdmi")) variants.push("HDMI кабель", "HDMI 2.1");
  if (words.includes("саундбар") || words.includes("soundbar")) {
    variants.push("саундбар", "саундбар Dolby Atmos");
  }
  if (words.includes("ноутбук")) {
    variants.push("как выбрать ноутбук для работы", "ноутбук для работы", "обзор ноутбука");
  }

  return [...new Set(variants.filter((variant) => variant.length > 1))].slice(0, 6);
}

function rankRelevantBlogArticles(articles: BlogArticle[], query: string): BlogArticle[] {
  const seen = new Set<string>();
  return articles
    .filter((article) => {
      if (!article.url || seen.has(article.url) || isBadBlogArticle(article, query)) return false;
      seen.add(article.url);
      return true;
    })
    .map((article, index) => {
      const score = blogRelevanceScore(article, query) - index / 100;
      return {
        ...article,
        score: Number(score.toFixed(2)),
        relevance: explainBlogRelevance(article, query, score),
      };
    })
    .filter((article) => (article.score || 0) >= 4)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 5);
}

function blogRelevanceScore(article: BlogArticle, query: string): number {
  const words = normalizeWords(query).filter((word) => !BLOG_STOP_WORDS.has(word));
  const categoryWords = words.filter((word) => BLOG_CATEGORY_WORDS.has(word));
  const title = article.title.toLowerCase();
  const url = article.url.toLowerCase();
  const text = `${title} ${article.snippet} ${url}`.toLowerCase();
  const textTerms = significantBlogTerms(text);
  if (categoryWords.length && !categoryWords.some((word) => text.includes(word))) return 0;

  let score = 0;
  for (const word of words) {
    if (title.includes(word)) score += 4;
    else if (url.includes(word)) score += 3;
    else if (text.includes(word)) score += 1.5;
  }
  for (const word of categoryWords) {
    if (title.includes(word) || url.includes(word)) score += 4;
  }
  for (const word of words) {
    if (!textTerms.some((term) => sameTermFamily(term, word))) score -= 3;
  }
  if (/как выбрать|что такое|чем отличаются|обзор|лучшие/i.test(article.title)) score += 2;
  if (url.includes("/pomogaem-razobratsya/") || url.includes("/obzory/")) score += 2;
  if (url.includes("/korotko/") || /слух|анонсирован|представил|выпустил/i.test(article.title)) {
    score -= 3;
  }
  return score;
}

function significantBlogTerms(text: string): string[] {
  return normalizeWords(text).filter((word) => !BLOG_STOP_WORDS.has(word));
}

function sameTermFamily(left: string, right: string): boolean {
  const a = left.replace(/ё/g, "е");
  const b = right.replace(/ё/g, "е");
  const size = Math.min(6, a.length, b.length);
  return size >= 4 && a.slice(0, size) === b.slice(0, size);
}

function hasUnrequestedAccessoryHead(title: string, query: string): boolean {
  const accessoryRoots = [
    "подстав",
    "сумк",
    "рюкзак",
    "чехл",
    "заряд",
    "кабел",
    "кроншт",
    "держател",
    "адаптер",
    "переходник",
  ];
  const queryTerms = significantBlogTerms(query);
  const titleHeadTerms = significantBlogTerms(title).slice(0, 4);
  const accessoryHead = titleHeadTerms.find((term) =>
    accessoryRoots.some((root) => term.startsWith(root)),
  );
  if (!accessoryHead) return false;
  return !queryTerms.some((term) => sameTermFamily(term, accessoryHead));
}

function explainBlogRelevance(article: BlogArticle, query: string, score: number): string {
  const queryTerms = significantBlogTerms(query);
  const articleTerms = significantBlogTerms(`${article.title} ${article.snippet}`);
  const overlap = queryTerms.filter((term) =>
    articleTerms.some((item) => sameTermFamily(item, term)),
  );
  if (overlap.length) return `Совпали темы: ${overlap.slice(0, 4).join(", ")}.`;
  return score >= 6
    ? "Статья близка по теме запроса и формату выбора/обзора."
    : "Пограничная релевантность — использовать только после проверки смысла статьи.";
}

function isBadBlogArticle(article: BlogArticle, query = ""): boolean {
  const text = `${article.title} ${article.url}`.toLowerCase();
  if (
    /appgallery|график релизов|games-calendar|top-gadgets-release|магазин приложений/.test(text)
  ) {
    return true;
  }

  return hasUnrequestedAccessoryHead(article.title, query);
}

function toProductFromMvideo(detail: MvideoDetail, price?: MvideoPrice): Product | null {
  const id = String(detail.productId || "");
  const title = stripTags(detail.name || "");
  if (!id || !title) return null;

  const salePrice = numberOrZero(price?.price?.salePrice || price?.price?.basePromoPrice);
  const basePrice = numberOrZero(price?.price?.basePrice);
  const category =
    [detail.category?.name, detail.brandName].filter(Boolean).join(" · ") || "Каталог";

  return {
    id,
    title,
    price: salePrice || basePrice,
    oldPrice: basePrice && salePrice && basePrice > salePrice ? basePrice : undefined,
    rating: numberOrZero(detail.rating?.star),
    reviews: numberOrZero(detail.rating?.count),
    image: mvideoImageUrl(detail.image || detail.images?.[0]),
    url: `${MVIDEO_ORIGIN}/products/${detail.nameTranslit || slugify(title)}-${id}`,
    stock: availabilityFromStatus(detail),
    margin: 0,
    category,
  };
}

function availabilityFromStatus(detail: MvideoDetail): Product["stock"] {
  if (detail.status?.soldOut) {
    return { warehouse: 0, store: 0, storeName: "Нет в наличии" };
  }
  if (detail.status?.availableOnlyInRetailStore) {
    return { warehouse: 0, store: 1, storeName: "Только в магазине" };
  }
  return { warehouse: 1, store: 1, storeName: "Наличие на mvideo.ru" };
}

function mvideoImageUrl(image?: string): string {
  if (!image) return `${MVIDEO_ORIGIN}/favicon.ico`;
  const clean = decodeHtml(image).replace(/\\\//g, "/");
  if (clean.startsWith("http")) return clean;
  if (clean.startsWith("//")) return `https:${clean}`;
  if (clean.startsWith("/")) return `${MVIDEO_IMAGE_ORIGIN}${clean}`;
  return `${MVIDEO_IMAGE_ORIGIN}/${clean}`;
}

function isPoisonPill(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("запросы, поступающие с") ||
    lower.includes("похожи на автоматические") ||
    lower.includes("captcha") ||
    lower.includes("too many requests") ||
    lower.includes("checking your browser")
  );
}

async function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const existing = cache.get(key) as CacheEntry<T> | undefined;
  if (existing && existing.expiresAt > now) return existing.value;
  const value = await loader();
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

function normalizeWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2);
}

function numberOrZero(value: unknown): number {
  const num = Number(value || 0);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "e")
    .replace(/[^a-zа-я0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function absolutizeMvideoUrl(url: string): string {
  if (!url) return MVIDEO_ORIGIN;
  const clean = decodeHtml(url).replace(/\\\//g, "/");
  if (clean.startsWith("http")) return clean;
  if (clean.startsWith("//")) return `https:${clean}`;
  if (clean.startsWith("/")) return `${MVIDEO_ORIGIN}${clean}`;
  return clean;
}

function findNearbyText(html: string, index: number, max: number): string {
  return stripTags(html.slice(index, index + 1400)).slice(0, max);
}

function stripTags(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>?/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

export function crossSellFor(_productId: string): { items: Product[]; rationale: string } {
  return { items: [], rationale: "" };
}
