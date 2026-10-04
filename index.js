const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const NodeCache = require("node-cache");

const BASE_URL = "https://supjav.com";
const FALLBACK_PROXY_URL = "https://supjavd.orzv.workers.dev";
const PORT = process.env.PORT || 7000;

// Initialize cache with 1-hour default TTL and standard check interval
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// Common browser headers to bypass basic scraping blocks
const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: BASE_URL,
};


/**
 * Decodes encoded SupJav server embed URLs (e.g., reversed strings, base64)
 * @param {string} encodedStr - The raw string from data-link or href attribute
 * @returns {string} - Decoded target embed URL
 */
function decodeSupJavLink(encodedStr) {
  if (!encodedStr) return "";
  try {
    let cleanStr = encodedStr.trim();

    // Direct HTTP(S) URL
    if (cleanStr.startsWith("http://") || cleanStr.startsWith("https://")) {
      return cleanStr;
    }

    // Protocol relative URL
    if (cleanStr.startsWith("//")) {
      return "https:" + cleanStr;
    }

    // Common SupJav protection technique: reversed string
    const reversed = cleanStr.split("").reverse().join("");
    if (reversed.startsWith("http://") || reversed.startsWith("https://")) {
      return reversed;
    }

    // Base64 decoded check
    const decodedBase64 = Buffer.from(cleanStr, "base64").toString("utf-8");
    if (decodedBase64.startsWith("http")) {
      return decodedBase64;
    }

    // Reversed Base64 check
    const decodedReversedBase64 = Buffer.from(reversed, "base64").toString("utf-8");
    if (decodedReversedBase64.startsWith("http")) {
      return decodedReversedBase64;
    }

    return cleanStr;
  } catch (error) {
    console.error("Error decoding link:", error.message);
    return encodedStr;
  }
}

/**
 * Executes robust HTTP GET request with retries and caching
 * @param {string} url - Target URL to fetch
 * @returns {Promise<string|null>} - HTML response body or null on failure
 */
async function fetchHtml(url) {
  const cachedData = cache.get(url);
  if (cachedData) {
    return cachedData;
  }

  try {
    const response = await axios.get(url, {
      headers: DEFAULT_HEADERS,
      timeout: 10000,
    });

    if (response.status === 200 && response.data) {
      cache.set(url, response.data);
      return response.data;
    }
  } catch (error) {
    console.error(`Failed to fetch HTML from ${url}:`, error.message);
  }
  return null;
}

const manifest = {
  id: "community.supjav",
  version: "1.0.0",
  name: "SupJav",
  description: "Streaming video metadata & links dari SupJav.com",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  catalogs: [
    {
      type: "movie",
      id: "supjav_catalog",
      name: "SupJav",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
  ],
  idPrefixes: ["supjav:"],
  background: "https://supjav.com/wp-content/uploads/2019/01/logo.png",
  logo: "https://supjav.com/wp-content/uploads/2019/01/logo.png",
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "movie" || id !== "supjav_catalog") {
    return { metas: [] };
  }

  const query = extra && extra.search ? extra.search.trim() : "";
  const skip = extra && extra.skip ? parseInt(extra.skip, 10) : 0;
  
  // Calculate target page based on Stremio pagination skip parameter (approx 20 items per page)
  const page = Math.floor(skip / 20) + 1;

  let requestUrl = "";
  if (query) {
    requestUrl = `${BASE_URL}/page/${page}/?s=${encodeURIComponent(query)}`;
  } else if (page > 1) {
    requestUrl = `${BASE_URL}/page/${page}/`;
  } else {
    requestUrl = BASE_URL;
  }

  console.log(`[Catalog] Fetching page ${page} with query "${query}": ${requestUrl}`);

  const html = await fetchHtml(requestUrl);
  if (!html) {
    return { metas: [] };
  }

  const $ = cheerio.load(html);
  const metas = [];

  $(".post, .item, article").each((_, element) => {
    const $el = $(element);
    
    // Extract video link and ID
    const link = $el.find("a").filter((_, a) => {
      const href = $(a).attr("href") || "";
      return href.includes(".html") || href.match(/\/\d+\.html/);
    }).first().attr("href");

    if (!link) return;

    const idMatch = link.match(/\/(\d+)\.html/);
    if (!idMatch) return;

    const numericId = idMatch[1];
    const itemTitle = $el.find(".entry-title, h2, h3, .title").text().trim() || `SupJav Video ${numericId}`;
    
    // Extract poster image
    let poster = $el.find("img").attr("data-original") || 
                 $el.find("img").attr("data-src") || 
                 $el.find("img").attr("src") || "";

    if (poster && poster.startsWith("//")) {
      poster = "https:" + poster;
    }

    metas.push({
      id: `supjav:${numericId}`,
      type: "movie",
      name: itemTitle,
      poster: poster,
      description: `SupJav Code: ${numericId}`,
    });
  });

  return { metas };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "movie" || !id.startsWith("supjav:")) {
    return { meta: null };
  }

  const numericId = id.replace("supjav:", "");
  const targetUrl = `${BASE_URL}/${numericId}.html`;

  console.log(`[Meta] Fetching metadata for ID: ${id} -> ${targetUrl}`);

  const html = await fetchHtml(targetUrl);
  if (!html) {
    return { meta: null };
  }

  const $ = cheerio.load(html);

  // Extract core metadata fields
  const title = $("h1, .entry-title").first().text().trim() || `SupJav ${numericId}`;
  
  const poster = $('meta[property="og:image"]').attr("content") || 
                 $(".post-thumbnail img, .entry-content img").first().attr("src") || "";

  const description = $('meta[name="description"]').attr("content") || 
                      $(".entry-content p").first().text().trim() || 
                      `Video ID: ${numericId}`;

  // Extract Cast / Actresses
  const cast = [];
  $(".cast a, .actress a, a[rel='tag']").each((_, el) => {
    const actorName = $(el).text().trim();
    if (actorName && !cast.includes(actorName)) {
      cast.push(actorName);
    }
  });

  // Extract Studio / Maker
  let maker = "";
  $(".maker a, .studio a, .cats a").first().each((_, el) => {
    maker = $(el).text().trim();
  });

  // Extract Genres / Categories / Tags
  const genres = [];
  if (maker) genres.push(maker);

  $(".tags a, .category a, .cats a").each((_, el) => {
    const genre = $(el).text().trim();
    if (genre && !genres.includes(genre)) {
      genres.push(genre);
    }
  });

  const meta = {
    id: id,
    type: "movie",
    name: title,
    poster: poster,
    background: poster,
    description: description,
    cast: cast.length > 0 ? cast : undefined,
    genres: genres.length > 0 ? genres : undefined,
  };

  return { meta };
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "movie" || !id.startsWith("supjav:")) {
    return { streams: [] };
  }

  const numericId = id.replace("supjav:", "");
  const targetUrl = `${BASE_URL}/${numericId}.html`;

  console.log(`[Stream] Extracting streams for ID: ${id} -> ${targetUrl}`);

  const streams = [];
  const html = await fetchHtml(targetUrl);

  if (html) {
    const $ = cheerio.load(html);

    // Parse player options / server list section
    const serverElements = $(".btn-server, .server-list a, .server a, .servers a, [data-link]");

    serverElements.each((i, el) => {
      const $el = $(el);
      const serverName = $el.text().trim() || `Server ${i + 1}`;
      const rawLink = $el.attr("data-link") || $el.attr("href") || $el.attr("data-api");

      if (!rawLink || rawLink.startsWith("#") || rawLink.startsWith("javascript:")) {
        return;
      }

      const decodedUrl = decodeSupJavLink(rawLink);

      if (decodedUrl) {
        // Detect server features and resolution indicator
        let quality = "720p";
        let isDirectMp4 = false;

        if (serverName.toLowerCase().includes("st") || decodedUrl.includes("streamtape")) {
          quality = "1080p";
          isDirectMp4 = true;
        } else if (serverName.toLowerCase().includes("tv") || serverName.toLowerCase().includes("voe")) {
          quality = "1080p";
        } else if (serverName.toLowerCase().includes("fst")) {
          quality = "720p";
        }

        streams.push({
          url: decodedUrl,
          name: `SupJav [${serverName.toUpperCase()}]`,
          title: `${serverName} - ${quality} ${isDirectMp4 ? "(Direct MP4)" : "(HLS Stream)"}`,
          quality: quality,
          isFree: true,
        });
      }
    });
  }

  // Fallback to primary M3U8 reverse proxy if no direct servers were parsed
  if (streams.length === 0) {
    console.log(`[Stream] No direct streams found. Injecting fallback proxy for ID ${numericId}`);
    
    streams.push({
      url: `${FALLBACK_PROXY_URL}/${numericId}.m3u8`,
      name: "SupJav [PROXY M3U8]",
      title: "Auto-proxy stream (1080p Max Quality)",
      quality: "1080p",
      isFree: true,
    });
  }

  return { streams };
});

const addonInterface = builder.getInterface();

serveHTTP(addonInterface, { port: PORT }).then(({ url }) => {
  console.log(`
=====================================================
🚀 SupJav Stremio Addon active at: ${url}
📄 Manifest URL: ${url}manifest.json
=====================================================
To install in Stremio app, open:
stremio://${url.replace(/^https?:\/\//, "")}manifest.json
=====================================================
  `);
});