import { getErrorCode } from './errors.js'

type SearchResult = {
  title: string
  link: string
  snippet: string
  date: string
  display_link: string
}

type SearchProvider = 'duckduckgo-lite' | 'sogou'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 CodeLite/0.1'
const DEFAULT_TIMEOUT_MS = 12000
const DEFAULT_MAX_RETRIES = 2

// 返回一个在指定毫秒后 resolve 的 Promise，用于重试延迟
// Return a Promise that resolves after the given milliseconds, used for retry backoff
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

// 判断 HTTP 状态码是否表示可重试的错误（429 或 5xx）
// Check whether an HTTP status code indicates a retryable error (429 or 5xx)
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

// 判断网络错误是否属于可重试类型（超时、连接重置、DNS 等）
// Check whether a network error is retryable (timeout, connection reset, DNS, etc.)
function isRetryableNetworkError(error: unknown): boolean {
  const code = getErrorCode(error)
  if (!code) {
    return error instanceof Error && error.name === 'AbortError'
  }

  return (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  )
}

// 将网络请求错误格式化为包含上下文信息的可读错误消息
// Format a web request error into a human-readable message with context info
function formatWebErrorMessage(args: {
  url: string
  error: unknown
  timeoutMs: number
}): string {
  const code = getErrorCode(args.error)
  if (code) {
    return `request failed (${code}) for ${args.url}`
  }

  if (args.error instanceof Error && args.error.name === 'AbortError') {
    return `request timed out after ${args.timeoutMs}ms for ${args.url}`
  }

  if (args.error instanceof Error && args.error.message) {
    return `${args.error.message} (${args.url})`
  }

  return `request failed for ${args.url}`
}

// 带指数退避重试和超时的 fetch 封装，自动重试临时性网络和服务端错误
// Fetch wrapper with exponential-backoff retry and timeout for transient network/server errors
async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  options?: {
    timeoutMs?: number
    maxRetries?: number
  },
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES
  const target = typeof url === 'string' ? url : url.toString()

  let lastError: unknown = null
  let lastResponse: Response | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      })
      clearTimeout(timeout)
      lastResponse = response

      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        await sleep(300 * Math.pow(2, attempt))
        continue
      }

      return response
    } catch (error) {
      clearTimeout(timeout)
      lastError = error
      if (attempt < maxRetries && isRetryableNetworkError(error)) {
        await sleep(300 * Math.pow(2, attempt))
        continue
      }
      throw new Error(
        formatWebErrorMessage({
          url: target,
          error,
          timeoutMs,
        }),
      )
    }
  }

  if (lastResponse) {
    return lastResponse
  }

  throw new Error(
    formatWebErrorMessage({
      url: target,
      error: lastError,
      timeoutMs,
    }),
  )
}

// 通过 DuckDuckGo Lite 或搜狗执行网页搜索，支持域名过滤和 fallback
// Execute a web search via DuckDuckGo Lite or Sogou with domain filtering and fallback
export async function searchDuckDuckGoLite(options: {
  query: string
  maxResults?: number
  allowedDomains?: string[]
  blockedDomains?: string[]
}): Promise<{
  organic: SearchResult[]
  base_resp: { status_code: number; status_msg: string; source: string }
}> {
  const allowed = normalizeDomainList(options.allowedDomains)
  const blocked = normalizeDomainList(options.blockedDomains)
  const maxResults = options.maxResults ?? 5
  const errors: string[] = []
  const providers: SearchProvider[] = ['duckduckgo-lite', 'sogou']

  for (const provider of providers) {
    try {
      const response = await fetchSearchPage(provider, options.query)
      if (!response.ok) {
        errors.push(`${provider}: HTTP ${response.status}`)
        continue
      }

      const html = await response.text()
      const parsed = parseSearchResults(provider, html)
      const organic = parsed
        .filter(r => passesDomainFilter(r.link, allowed, blocked))
        .slice(0, maxResults)

      if (organic.length > 0) {
        return {
          organic,
          base_resp: {
            status_code: response.status,
            status_msg: response.statusText,
            source: provider,
          },
        }
      }

      errors.push(`${provider}: no results`)
    } catch (error) {
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`all search providers failed (${errors.join('; ')})`)
  }

  return {
    organic: [],
    base_resp: {
      status_code: 200,
      status_msg: 'OK',
      source: 'fallback-empty',
    },
  }
}

// 抓取网页内容并提取可读文本，支持 HTML 重定向和标题提取
// Fetch a web page and extract readable text, supporting HTML redirects and title extraction
export async function fetchWebPage(options: {
  url: string
  maxChars?: number
}): Promise<{
  url: string
  finalUrl: string
  status: number
  statusText: string
  contentType: string
  title: string | null
  content: string
}> {
  const requestInit: RequestInit = {
    headers: {
      'user-agent': USER_AGENT,
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
      'accept-language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  }

  let response = await fetchWithRetry(options.url, requestInit)
  let text = await response.text()
  let contentType = response.headers.get('content-type') ?? ''
  let finalUrl = response.url || options.url

  if (contentType.includes('html')) {
    const htmlRedirectUrl = extractHtmlRedirectUrl(text, finalUrl)
    if (htmlRedirectUrl && htmlRedirectUrl !== finalUrl) {
      response = await fetchWithRetry(htmlRedirectUrl, requestInit)
      text = await response.text()
      contentType = response.headers.get('content-type') ?? ''
      finalUrl = response.url || htmlRedirectUrl
    }
  }
  const maxChars = options.maxChars ?? 12000

  if (contentType.includes('html')) {
    return {
      url: options.url,
      finalUrl,
      status: response.status,
      statusText: response.statusText,
      contentType,
      title: extractTitle(text),
      content: extractReadableText(text).slice(0, maxChars),
    }
  }

  return {
    url: options.url,
    finalUrl,
    status: response.status,
    statusText: response.statusText,
    contentType,
    title: null,
    content: text.slice(0, maxChars),
  }
}

// 向指定的搜索提供商发起搜索请求，返回原始 HTML 响应
// Send a search request to the specified provider and return the raw HTML response
function fetchSearchPage(provider: SearchProvider, query: string): Promise<Response> {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  }

  if (provider === 'duckduckgo-lite') {
    const url = new URL('https://lite.duckduckgo.com/lite/')
    url.searchParams.set('q', query)
    headers['accept-language'] = 'en-US,en;q=0.9'
    return fetchWithRetry(url, { headers })
  }

  if (provider === 'sogou') {
    const url = new URL('https://www.sogou.com/web')
    url.searchParams.set('query', query)
    headers['accept-language'] = 'zh-CN,zh;q=0.9,en;q=0.6'
    return fetchWithRetry(url, { headers })
  }

  throw new Error(`unsupported search provider: ${provider}`)
}

// 根据搜索提供商类型，将原始 HTML 解析为结构化搜索结果列表
// Parse raw HTML into structured search results based on the provider type
function parseSearchResults(provider: SearchProvider, html: string): SearchResult[] {
  if (provider === 'duckduckgo-lite') {
    return parseDuckDuckGoLite(html)
  }

  return parseSogouSearch(html)
}

// 从 DuckDuckGo Lite 的 HTML 页面中提取搜索结果条目
// Extract search result entries from DuckDuckGo Lite HTML pages
function parseDuckDuckGoLite(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const anchorPattern = /<a\b[^>]*>[\s\S]*?<\/a>/giu
  const matches = [...html.matchAll(anchorPattern)]

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]
    const anchorHtml = match?.[0] ?? ''
    if (!anchorHtml) continue

    const classValue = firstMatch(/class=(['"])([\s\S]*?)\1/iu, anchorHtml, 2) ?? ''
    if (!/\bresult-link\b/i.test(classValue)) continue

    const rawHref = firstMatch(/href=(['"])([\s\S]*?)\1/iu, anchorHtml, 2) ?? ''
    const title = decodeHtml(stripTags(firstMatch(/<a\b[^>]*>([\s\S]*?)<\/a>/iu, anchorHtml) ?? ''))
    const nextMatch = matches[i + 1]
    const block = html.slice(match?.index ?? 0, nextMatch?.index ?? html.length)
    const snippet = decodeHtml(
      stripTags(
        firstMatch(
          /<td[^>]*class=(['"])[^'"]*\bresult-snippet\b[^'"]*\1[^>]*>\s*([\s\S]*?)\s*<\/td>/iu,
          block,
          2,
        ) ?? '',
      ),
    )
    const displayLink = decodeHtml(
      stripTags(
        firstMatch(
          /<span[^>]*class=(['"])[^'"]*\blink-text\b[^'"]*\1[^>]*>([\s\S]*?)<\/span>/iu,
          block,
          2,
        ) ?? '',
      ),
    )
    const link = normalizeDuckDuckGoLink(rawHref)

    if (!title || !link) continue
    results.push({ title, link, snippet, date: '', display_link: displayLink })
  }

  return results
}

// 从搜狗搜索的 HTML 页面中提取搜索结果条目
// Extract search result entries from Sogou search HTML pages
function parseSogouSearch(html: string): SearchResult[] {
  const h3Pattern = /<h3\b[^>]*>\s*([\s\S]*?)<\/h3>/giu
  const matches = [...html.matchAll(h3Pattern)]
  const results: SearchResult[] = []

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]
    if (!match) continue

    const h3Html = match[0]
    const rawHref = decodeHtml(firstMatch(/href=(['"])([\s\S]*?)\1/iu, h3Html, 2) ?? '')
    const title = decodeHtml(
      stripTags(firstMatch(/<a\b[^>]*>([\s\S]*?)<\/a>/iu, h3Html, 1) ?? ''),
    )
    const link = normalizeSogouLink(rawHref)

    if (!title || !link) continue

    const next = matches[i + 1]
    const block = html.slice(match.index ?? 0, next?.index ?? html.length)
    const snippet = decodeHtml(
      stripTags(
        firstMatch(
          /<(div|p)\b[^>]*class=(['"])[^'"]*(fz-mid|str-text-info|text-layout|space-txt)[^'"]*\2[^>]*>([\s\S]*?)<\/\1>/iu,
          block,
          4,
        ) ?? '',
      ),
    )

    let displayLink = ''
    try {
      displayLink = new URL(link).hostname
    } catch {
      displayLink = link
    }

    results.push({
      title,
      link,
      snippet,
      date: '',
      display_link: displayLink,
    })
  }

  return results
}

// 将域名列表规范化为统一格式，过滤通配符并提取 hostname
// Normalize a domain list into a uniform format, stripping wildcards and extracting hostnames
function normalizeDomainList(domains: string[] | undefined): string[] {
  return (domains ?? [])
    .map((d) => {
      const raw = d.trim().toLowerCase()
      if (!raw) return ''
      const withoutWildcard = raw.replace(/^\*\./, '').replace(/^\./, '')
      try {
        return new URL(withoutWildcard).hostname.toLowerCase()
      } catch {
        return withoutWildcard
      }
    })
    .filter(Boolean)
}

// 检查链接是否通过域名白名单和黑名单过滤
// Check whether a link passes the domain allowlist and blocklist filters
function passesDomainFilter(
  link: string,
  allowed: string[],
  blocked: string[],
): boolean {
  let host = ''
  try {
    host = new URL(link).hostname.toLowerCase()
  } catch {
    return false
  }
  if (blocked.some((d) => matchesDomain(host, d))) return false
  if (allowed.length === 0) return true
  return allowed.some((d) => matchesDomain(host, d))
}

// 判断主机名是否与指定域名或其子域名匹配
// Check whether a hostname matches a domain or any of its subdomains
function matchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

// 返回正则表达式在文本中首次匹配的捕获组，未匹配则返回 null
// Return the first regex capture group match in text, or null if no match
function firstMatch(pattern: RegExp, text: string, group: number = 1): string | null {
  return text.match(pattern)?.[group] ?? null
}

// 将 DuckDuckGo 搜索结果中的链接标准化，解析重定向参数为真实 URL
// Normalize DuckDuckGo search-result links by resolving redirect parameters to real URLs
function normalizeDuckDuckGoLink(rawHref: string): string {
  const href = decodeHtml(rawHref).trim()
  if (!href) return ''
  const absolute = href.startsWith('//') ? `https:${href}` : href
  try {
    const url = new URL(absolute)
    const redirect = url.searchParams.get('uddg')
    return redirect ? decodeURIComponent(redirect) : url.toString()
  } catch {
    return absolute
  }
}

// 将搜狗搜索结果中的链接标准化为完整的绝对 URL
// Normalize Sogou search-result links into full absolute URLs
function normalizeSogouLink(rawHref: string): string {
  if (!rawHref) return ''
  const href = decodeHtml(rawHref).trim()
  if (!href) return ''
  if (href.startsWith('/')) {
    return `https://www.sogou.com${href}`
  }
  if (href.startsWith('//')) {
    return `https:${href}`
  }
  return href
}

// 从 HTML 中检测并提取 JavaScript 或 meta-refresh 重定向的目标 URL
// Detect and extract JavaScript or meta-refresh redirect target URLs from HTML
function extractHtmlRedirectUrl(html: string, baseUrl: string): string | null {
  const scriptRedirect =
    firstMatch(
      /window\.location(?:\.href)?(?:\.replace)?\((['"])(.*?)\1\)/iu,
      html,
      2,
    ) ??
    firstMatch(
      /window\.location(?:\.href)?\s*=\s*(['"])(.*?)\1/iu,
      html,
      2,
    )
  const metaRefresh =
    firstMatch(
      /<meta[^>]*http-equiv=(['"])refresh\1[^>]*content=(['"])[\s\S]*?url\s*=\s*('?)([^"'>;]+)\3[\s\S]*?\2[^>]*>/iu,
      html,
      4,
    ) ??
    firstMatch(
      /<meta[^>]*content=(['"])[\s\S]*?url\s*=\s*('?)([^"'>;]+)\2[\s\S]*?\1[^>]*http-equiv=(['"])refresh\4[^>]*>/iu,
      html,
      3,
    )

  const raw = decodeHtml((scriptRedirect ?? metaRefresh ?? '').trim())
  if (!raw) return null

  try {
    return new URL(raw, baseUrl).toString()
  } catch {
    return null
  }
}

// 从 HTML 页面的 <title> 标签中提取页面标题
// Extract the page title from the <title> tag in HTML
function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)
  return match ? decodeHtml(stripTags(match[1] ?? '')).trim() : null
}

// 从 HTML 中移除脚本、样式和标签，提取纯文本内容
// Remove scripts, styles, and tags from HTML to extract plain readable text
function extractReadableText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style[\s\S]*?<\/style>/giu, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/giu, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/giu, ' ')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  )
}

// 移除字符串中的所有 HTML 标签并将空白字符压缩为单空格
// Strip all HTML tags from a string and collapse whitespace to single spaces
function stripTags(value: string): string {
  return value.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim()
}

// 将常见的 HTML 实体编码（&amp; &lt; &gt; &#x27; 等）解码为原始字符
// Decode common HTML entities (&amp; &lt; &gt; &#x27; etc.) back to their plain characters
function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;/gu, "'")
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&#x2F;/gu, '/')
    .replace(/&#47;/gu, '/')
    .replace(/&nbsp;/gu, ' ')
}
