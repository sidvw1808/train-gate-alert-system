/**
 * Ghorpadi Route Bot — Cloudflare Worker
 * Amanora -> AISSMS College route checker.
 *
 * Two entry points:
 * - fetch(): Telegram webhook. Fires the instant someone messages the bot.
 * - scheduled(): Cloudflare Cron Trigger. Runs the daily 8 AM broadcast.
 */

const ORIGIN = "18.520408,73.9398963"; // Amanora Park Town, Hadapsar, Pune
const DESTINATION = "18.5312718,73.8664078"; // AISSMS College of Engineering, Pune
const GHORPADI_BASELINE_MIN = 25;
const GATE_DELAY_BUFFER_MIN = 7;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Ghorpadi route bot webhook is running.", { status: 200 });
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("bad request", { status: 400 });
    }

    // Respond to Telegram immediately; do the actual work in the background
    // so Telegram doesn't time out waiting for the Google Maps call.
    ctx.waitUntil(handleUpdate(update, env));
    return new Response("OK", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyBroadcast(env));
  },
};

// ---------- Telegram update handling ----------

async function handleUpdate(update, env) {
  const message = update.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim().toLowerCase();
  const subscribers = await getSubscribers(env);

  // Log a readable profile so you can see who messaged and what they said
  await logMessage(env, message);

  if (text === "stop" || text === "unsubscribe") {
    if (subscribers.has(chatId)) {
      subscribers.delete(chatId);
      await saveSubscribers(env, subscribers);
      await sendTelegram(env, chatId, "You've been unsubscribed from Ghorpadi Gate Alerts.");
    }
    return;
  }

  const isNew = !subscribers.has(chatId);
  if (isNew) {
    subscribers.add(chatId);
    await saveSubscribers(env, subscribers);
  }

  let status;
  try {
    status = await buildStatusMessage(env);
  } catch (e) {
    status = `⚠️ Couldn't fetch route status right now (${e.message}).`;
  }

  if (isNew) {
    status =
      "✅ You're subscribed to Ghorpadi Gate Alerts! You'll get a message " +
      "every morning around 8 AM, and any time you message me I'll reply " +
      "instantly with the current status. Text 'stop' to unsubscribe.\n\n" +
      status;
  }

  await sendTelegram(env, chatId, status);
}

async function dailyBroadcast(env) {
  const subscribers = await getSubscribers(env);
  if (subscribers.size === 0) return;

  let status;
  try {
    status = await buildStatusMessage(env);
  } catch (e) {
    status = `⚠️ Route check failed: ${e.message}`;
  }

  const message = "🚦 8 AM Route Check\n\n" + status;
  for (const chatId of subscribers) {
    try {
      await sendTelegram(env, chatId, message);
    } catch (e) {
      console.error(`Failed to send to ${chatId}: ${e.message}`);
    }
  }
}

// ---------- Subscriber storage (Cloudflare KV) ----------

async function getSubscribers(env) {
  const raw = await env.SUBSCRIBERS.get("chat_ids");
  const arr = raw ? JSON.parse(raw) : [];
  return new Set(arr);
}

async function saveSubscribers(env, set) {
  await env.SUBSCRIBERS.put("chat_ids", JSON.stringify([...set]));
}

async function logMessage(env, message) {
  const chatId = message.chat.id;
  const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ");
  const username = message.from?.username ? `@${message.from.username}` : null;

  const raw = await env.SUBSCRIBERS.get("profiles");
  const profiles = raw ? JSON.parse(raw) : {};

  profiles[chatId] = {
    name: name || "(no name set)",
    username,
    lastMessage: message.text,
    lastSeen: new Date().toISOString(),
  };

  await env.SUBSCRIBERS.put("profiles", JSON.stringify(profiles));
}

// ---------- Telegram send ----------

async function sendTelegram(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram send failed: ${resp.status} ${body}`);
  }
}

// ---------- Route checking (Google Directions API) ----------

async function fetchRoutes(env) {
  const params = new URLSearchParams({
    origin: ORIGIN,
    destination: DESTINATION,
    alternatives: "true",
    departure_time: "now",
    traffic_model: "best_guess",
    region: "in",
    key: env.GOOGLE_MAPS_API_KEY,
  });
  const resp = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
  const data = await resp.json();
  if (data.status !== "OK") {
    throw new Error(`Directions API error: ${data.status} ${data.error_message || ""}`);
  }
  return data.routes;
}

function summarizeRoute(route) {
  const leg = route.legs[0];
  const distanceM = leg.distance.value;
  const durationS = (leg.duration_in_traffic || leg.duration).value;
  const summary = route.summary || "";
  const roadNames = (leg.steps || []).map((s) => s.html_instructions || "").join(" ");
  return { distanceM, durationMin: durationS / 60, summary, roadNames };
}

function identifyRoutes(routes) {
  // Shortest-distance route = Ghorpadi (it's the short route).
  // Any other route mentioning "Koregaon" = Koregaon Park route.
  const summarized = routes.map(summarizeRoute).sort((a, b) => a.distanceM - b.distanceM);
  const ghorpadi = summarized[0];
  let koregaon = null;
  for (const r of summarized.slice(1)) {
    if (r.summary.toLowerCase().includes("koregaon") || r.roadNames.toLowerCase().includes("koregaon")) {
      koregaon = r;
      break;
    }
  }
  if (!koregaon && summarized.length > 1) {
    koregaon = summarized[summarized.length - 1]; // fallback: longest alternative
  }
  return { ghorpadi, koregaon };
}

async function buildStatusMessage(env) {
  const routes = await fetchRoutes(env);
  if (!routes || routes.length === 0) {
    return "⚠️ Route check failed: no routes returned from Google Maps.";
  }

  const { ghorpadi, koregaon } = identifyRoutes(routes);
  const ghorpadiMin = ghorpadi.durationMin;
  const koregaonMin = koregaon ? koregaon.durationMin : null;
  const delay = ghorpadiMin - GHORPADI_BASELINE_MIN;

  const lines = ["🚦 Route Check — Amanora → AISSMS", ""];
  lines.push(`Ghorpadi route: ${Math.round(ghorpadiMin)} min (normal ~${GHORPADI_BASELINE_MIN} min)`);
  if (koregaonMin !== null) {
    lines.push(`Koregaon Park route: ${Math.round(koregaonMin)} min`);
  }
  lines.push("");

  // Informational flag only - does NOT decide the recommendation.
  if (delay > GATE_DELAY_BUFFER_MIN) {
    lines.push(`⚠️ Ghorpadi is running ${Math.round(delay)} min slower than usual — gate may be down.`);
  }

  // Recommendation: always whichever is actually faster right now.
  if (koregaonMin !== null && koregaonMin < ghorpadiMin) {
    lines.push("👉 Koregaon Park is faster right now — take that route.");
  } else {
    lines.push("👉 Ghorpadi is still the faster route — take that.");
  }

  return lines.join("\n");
}
