const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ✅ CORS fix — must be before everything else
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.options("*", cors());
app.use(express.json());

/* ── Supabase ── */
const supabase = createClient(
  "https://xptoxwulksgfeezpubau.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhwdG94d3Vsa3NnZmVlenB1YmF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4MDkwNTUsImV4cCI6MjA5MzM4NTA1NX0.U4Z0hffpZ_PrRIxwJIvNthfnUVWtowYM3vsBu_maFEE"
);

/* ── In-memory live state ── */
let liveState = {
  boards: {
    1: { voltage: 0, current: 0, power: 0, relay: true },
    2: { voltage: 0, current: 0, power: 0, relay: true },
    3: { voltage: 0, current: 0, power: 0, relay: true },
    4: { voltage: 0, current: 0, power: 0, relay: true }
  },
  temperature: 0,
  gas: 0,
  fan: false,
  alerts: [],
  ai: { risk: "LOW", message: "System stable", score: 0 }
};

/* ── Cached thresholds ── */
let thresholds = {
  board1_warn: 150, board1_trip: 300,
  board2_warn: 150, board2_trip: 300,
  board3_warn: 150, board3_trip: 300,
  temp_fan_on: 40,  gas_alert: 2000
};

async function loadThresholds() {
  const { data, error } = await supabase
    .from("thresholds")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();
  if (!error && data) thresholds = data;
}

function pushAlert(msg) {
  const last = liveState.alerts.at(-1);
  if (last?.message === msg) return;
  liveState.alerts.unshift({ message: msg, time: new Date().toISOString() });
  if (liveState.alerts.length > 30) liveState.alerts.pop();
}

function computeAI() {
  const powers = [1, 2, 3].map(i => liveState.boards[i].power);
  const maxPow  = Math.max(...powers);
  const trips   = [thresholds.board1_trip, thresholds.board2_trip, thresholds.board3_trip];
  const maxTrip = Math.max(...trips);
  const pct     = (maxPow / maxTrip) * 100;
  let risk = "LOW", score = Math.min(100, Math.round(pct));

  if (liveState.gas > thresholds.gas_alert)         { risk = "CRITICAL"; score = 100; }
  else if (pct >= 90 || liveState.temperature > 55) { risk = "CRITICAL"; score = Math.max(score, 95); }
  else if (pct >= 70 || liveState.temperature > 50) { risk = "HIGH";     score = Math.max(score, 75); }
  else if (pct >= 40 || liveState.temperature > thresholds.temp_fan_on) { risk = "MEDIUM"; score = Math.max(score, 45); }

  const messages = {
    LOW:      "All systems nominal",
    MEDIUM:   "Elevated load — monitor closely",
    HIGH:     "High load — prepare to shed",
    CRITICAL: "Critical — immediate action needed"
  };
  liveState.ai = { risk, score, message: messages[risk] };
}

function applyThresholds() {
  const trips = [thresholds.board1_trip, thresholds.board2_trip, thresholds.board3_trip];
  const warns = [thresholds.board1_warn, thresholds.board2_warn, thresholds.board3_warn];

  for (let i = 1; i <= 3; i++) {
    const pow = liveState.boards[i].power;
    if (pow > trips[i - 1]) {
      liveState.boards[i].relay = false;
      pushAlert(`Board ${i} tripped — ${pow.toFixed(0)}W exceeded ${trips[i-1]}W`);
    } else if (pow > warns[i - 1]) {
      pushAlert(`Board ${i} warning — ${pow.toFixed(0)}W approaching ${trips[i-1]}W`);
    }
  }

  const fanOn = liveState.temperature > thresholds.temp_fan_on
             || liveState.gas > thresholds.gas_alert;
  liveState.fan = fanOn;
  liveState.boards[4].relay = fanOn;

  if (liveState.gas > thresholds.gas_alert) {
    pushAlert("Gas leak — all boards shutting down");
    [1, 2, 3].forEach(i => (liveState.boards[i].relay = false));
  }
}

async function saveReading() {
  const b = liveState.boards;
  const { error } = await supabase.from("sensor_data").insert([{
    board1_voltage: b[1].voltage, board1_current: b[1].current, board1_power: b[1].power,
    board2_voltage: b[2].voltage, board2_current: b[2].current, board2_power: b[2].power,
    board3_voltage: b[3].voltage, board3_current: b[3].current, board3_power: b[3].power,
    temperature: liveState.temperature,
    gas: liveState.gas,
    fan_on: liveState.fan,
    relay1: b[1].relay, relay2: b[2].relay, relay3: b[3].relay,
    ai_risk: liveState.ai.risk,
    ai_score: liveState.ai.score
  }]);
  if (error) console.error("Supabase insert error:", error.message);
}

/* ══════════════ ROUTES ══════════════ */

app.get("/", (req, res) => res.send("MCB Backend Online"));

app.post("/api/data", async (req, res) => {
  try {
    await loadThresholds();
    const d = req.body;

// ======================================
// BOARD 1 MASTER SYNC
// ======================================

if (d.board1) {

  const voltage = d.board1.voltage ?? 0;
  const current = d.board1.current ?? 0;
  const power   = voltage * current;

  // ===== BOARD 1 =====
  liveState.boards[1].voltage = voltage;
  liveState.boards[1].current = current;
  liveState.boards[1].power   = power;

  // ===== BOARD 2 SYNC =====
  liveState.boards[2].voltage = voltage;
  liveState.boards[2].current = current;
  liveState.boards[2].power   = power;

  // ===== BOARD 3 SYNC =====
  liveState.boards[3].voltage = voltage;
  liveState.boards[3].current = current;
  liveState.boards[3].power   = power;
}
    if (d.temperature !== undefined) liveState.temperature = d.temperature;
    if (d.gas !== undefined)         liveState.gas = d.gas;

    applyThresholds();
    computeAI();
    await saveReading();

    res.json({
      status: "OK",
      relays: {
        1: liveState.boards[1].relay,
        2: liveState.boards[2].relay,
        3: liveState.boards[3].relay,
        4: liveState.boards[4].relay
      },
      ai: liveState.ai
    });
  } catch (err) {
    console.error("POST /api/data error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/data", (req, res) => res.json(liveState));

app.get("/api/history", async (req, res) => {
  const { data, error } = await supabase
    .from("sensor_data")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.reverse());
});

app.get("/api/threshold", async (req, res) => {
  const { data, error } = await supabase
    .from("thresholds")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/threshold", async (req, res) => {
  try {
    const t = req.body;
    const { error } = await supabase.from("thresholds").insert([{
      board1_warn: t.board1_warn, board1_trip: t.board1_trip,
      board2_warn: t.board2_warn, board2_trip: t.board2_trip,
      board3_warn: t.board3_warn, board3_trip: t.board3_trip,
      temp_fan_on: t.temp_fan_on,
      gas_alert:   t.gas_alert
    }]);
    if (error) return res.status(500).json({ error: error.message });
    thresholds = { ...thresholds, ...t };
    res.json({ status: "saved" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/relay/:board", (req, res) => {
  const b = parseInt(req.params.board);
  const { state } = req.body;
  if (b >= 1 && b <= 4) {
    liveState.boards[b].relay = state;
    pushAlert(`Board ${b} manually ${state ? "turned ON" : "switched OFF"}`);
    res.json({ status: "ok", relay: state });
  } else {
    res.status(400).json({ error: "Invalid board" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));