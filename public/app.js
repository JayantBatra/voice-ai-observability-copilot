// app.js — Vue 3 dashboard for the Voice AI Observability Copilot.
// Three surfaces: Overview (all agents) -> Agent deep-dive -> Call/transcript viewer.
// Uses the Vue global build (no bundler). State-based routing keeps it simple.

const { createApp, ref, reactive, onMounted, computed } = Vue;

const api = (p) => fetch(p).then(r => r.json());

const healthClass = (h) => (h >= 70 ? "g" : h >= 40 ? "w" : "b");
const pct = (n) => `${Math.round(n * 100)}%`;
const fmtType = (t) => (t || "").replace(/_/g, " ");
const fmtDate = (s) => (s ? new Date(s).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const modeLabel = (m) => ({
  demo: "Demo fixture mode",
  live: "Live HighLevel sandbox",
  "live-awaiting-install": "Live mode awaiting install"
}[m] || "Unknown mode");

const app = createApp({
  setup() {
    const view = reactive({ name: "overview", agentId: null, callId: null });
    const loading = ref(true);
    const overview = ref(null);
    const agent = ref(null);
    const call = ref(null);
    const useActions = ref([]);
    const params = new URLSearchParams(window.location.search);
    const pageContext = {
      locationId: params.get("location_id"),
      userEmail: params.get("user_email")
    };

    async function goOverview() {
      view.name = "overview"; loading.value = true;
      [overview.value, useActions.value] = await Promise.all([api("/api/overview"), api("/api/use-actions")]);
      loading.value = false;
    }
    async function goAgent(id) {
      view.name = "agent"; view.agentId = id; loading.value = true;
      agent.value = await api(`/api/agents/${id}`);
      loading.value = false;
    }
    async function goCall(id) {
      view.name = "call"; view.callId = id; loading.value = true;
      call.value = await api(`/api/calls/${id}`);
      loading.value = false;
    }

    onMounted(goOverview);

    // ---- computed helpers for the call viewer ----
    const flaggedSpans = computed(() => (call.value?.result?.deviations || []).filter(d => d.span));
    function turnFlagged(turn) {
      return flaggedSpans.value.some(d => turn.tStart >= d.span.start - 0.01 && turn.tStart <= d.span.end + 0.01);
    }

    return { view, loading, overview, agent, call, useActions, pageContext,
      goOverview, goAgent, goCall, healthClass, pct, fmtType, fmtDate, modeLabel, turnFlagged };
  },
  template: `
  <div class="app">
    <header class="top">
      <div>
        <h1>Voice AI Observability Copilot</h1>
        <div class="sub">Automated Monitor + Analyze for HighLevel Voice AI agents</div>
      </div>
      <a class="btn" @click="goOverview">Overview</a>
    </header>

    <div v-if="overview?.status" class="statusbar">
      <span class="pill" :class="overview.status.mode === 'live' ? 'good' : overview.status.mode === 'demo' ? 'warn' : 'mute'">
        {{ modeLabel(overview.status.mode) }}
      </span>
      <span v-if="pageContext.locationId">Embedded location: {{ pageContext.locationId }}</span>
      <span v-else-if="overview.status.lastSyncLocationId">Synced location: {{ overview.status.lastSyncLocationId }}</span>
      <span v-if="overview.status.lastSyncAt">Last synced {{ fmtDate(overview.status.lastSyncAt) }}</span>
      <span v-if="overview.status.lastAnalyzedAt">Last analyzed {{ fmtDate(overview.status.lastAnalyzedAt) }}</span>
    </div>

    <div v-if="loading" class="empty">Loading…</div>

    <!-- ===================== OVERVIEW ===================== -->
    <template v-else-if="view.name === 'overview'">
      <div class="kpis" v-if="overview">
        <div class="kpi"><div class="label">Calls scored</div><div class="value">{{ overview.portfolio.callsScored }}</div></div>
        <div class="kpi"><div class="label">Goal completion</div><div class="value">{{ pct(overview.portfolio.goalCompletionRate) }}</div></div>
        <div class="kpi"><div class="label">Avg health</div><div class="value" :class="'health ' + healthClass(overview.portfolio.avgHealth)">{{ overview.portfolio.avgHealth }}</div></div>
        <div class="kpi"><div class="label">Use-Actions open</div><div class="value">{{ overview.portfolio.openUseActions }}</div></div>
      </div>

      <div class="card">
        <h2>Agent health</h2>
        <table>
          <thead><tr><th>Agent</th><th>Calls</th><th>Goal rate</th><th>Top failure</th><th>Health</th><th></th></tr></thead>
          <tbody>
            <tr v-for="a in overview.agents" :key="a.id" class="clickable" @click="goAgent(a.id)">
              <td><strong>{{ a.name }}</strong><div class="muted">{{ a.goal }}</div></td>
              <td>{{ a.callsScored }}</td>
              <td>{{ pct(a.goalCompletionRate) }}</td>
              <td><span class="pill" :class="a.topFailure ? 'warn' : 'good'">{{ a.topFailure ? fmtType(a.topFailure) : 'none' }}</span></td>
              <td><span class="health" :class="healthClass(a.avgHealth)">{{ a.avgHealth }}</span></td>
              <td><span v-if="a.needsAttention" class="pill bad">needs attention</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>Use-Actions queue <span class="muted">— segments needing a human or worth training on</span></h2>
        <div v-if="!useActions.length" class="empty">Nothing flagged. 🎉</div>
        <table v-else>
          <thead><tr><th>Reason</th><th>Contact</th><th>Note</th><th>When</th><th></th></tr></thead>
          <tbody>
            <tr v-for="(u,i) in useActions" :key="i" class="clickable" @click="goCall(u.callId)">
              <td><span class="pill" :class="u.reason === 'human_review' ? 'bad' : 'mute'">{{ fmtType(u.reason) }}</span></td>
              <td>{{ u.contactName }}</td>
              <td class="muted">{{ u.note }}</td>
              <td class="muted">{{ fmtDate(u.startedAt) }}</td>
              <td><a>view →</a></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ===================== AGENT DEEP-DIVE ===================== -->
    <template v-else-if="view.name === 'agent' && agent">
      <div class="crumbs"><a @click="goOverview">Overview</a><span>{{ agent.agent.name }}</span></div>
      <div class="kpis">
        <div class="kpi"><div class="label">Calls scored</div><div class="value">{{ agent.summary.callsScored }}</div></div>
        <div class="kpi"><div class="label">Goal completion</div><div class="value">{{ pct(agent.summary.goalCompletionRate) }}</div></div>
        <div class="kpi"><div class="label">Avg health</div><div class="value" :class="'health ' + healthClass(agent.summary.avgHealth)">{{ agent.summary.avgHealth }}</div></div>
        <div class="kpi"><div class="label">Open recs</div><div class="value">{{ agent.summary.openRecommendations }}</div></div>
      </div>

      <div class="split">
        <div>
          <div class="card">
            <h2>Prompt/script recommendations <span class="muted">— ranked by severity × frequency</span></h2>
            <div v-if="!agent.recommendations.length" class="empty">No issues found.</div>
            <div v-for="r in agent.recommendations" :key="r.signature" class="rec">
              <div class="rhead">
                <span class="title">{{ r.title }}</span>
                <span class="pill" :class="r.severity === 'high' ? 'bad' : r.severity === 'medium' ? 'warn' : 'mute'">{{ r.severity }}</span>
              </div>
              <div class="why">{{ r.rationale }}</div>
              <div class="diff">{{ r.proposedPromptDiff }}</div>
              <div class="meta">
                <span class="tag">{{ r.frequency }} call(s)</span>
                <span class="tag">confidence {{ pct(r.confidence) }}</span>
                <span class="src" :class="r.source">{{ r.source === 'llm' ? 'LLM-written' : 'rule-based' }}</span>
                &nbsp;·&nbsp; evidence:
                <a v-for="cid in r.supportingCallIds" :key="cid" @click="goCall(cid)">{{ cid }}</a>
              </div>
            </div>
          </div>
        </div>
        <div>
          <div class="card">
            <h2>Observability parameters</h2>
            <div class="muted">Goal: {{ agent.agent.goal || 'No explicit goal found; using configured KPI template.' }}</div>
            <ul class="checklist" style="margin-top:8px">
              <li v-for="s in agent.agent.requiredSteps" :key="s.key">
                <span class="dot g"></span> {{ s.label }}
              </li>
            </ul>
            <div class="meta">
              Type: {{ fmtType(agent.agent.type) }} ·
              Min health: {{ agent.agent.thresholds.minHealth ?? 70 }} ·
              Max dead air: {{ agent.agent.thresholds.maxDeadAirSec ?? 'n/a' }}s
            </div>
          </div>
          <div class="card">
            <h2>Failure breakdown</h2>
            <table>
              <tbody>
                <tr v-for="(n,type) in agent.failureBreakdown" :key="type">
                  <td>{{ fmtType(type) }}</td><td style="text-align:right"><strong>{{ n }}</strong></td>
                </tr>
              </tbody>
            </table>
            <div v-if="!Object.keys(agent.failureBreakdown).length" class="empty">Clean.</div>
          </div>
          <div class="card">
            <h2>Calls</h2>
            <table>
              <tbody>
                <tr v-for="c in agent.calls" :key="c.callId" class="clickable" @click="goCall(c.callId)">
                  <td>{{ c.contactName }}<div class="muted">{{ fmtDate(c.startedAt) }}</div></td>
                  <td style="text-align:center">
                    <span class="pill" :class="c.goalCompleted ? 'good' : 'bad'">{{ c.goalCompleted ? 'goal met' : 'missed' }}</span>
                  </td>
                  <td style="text-align:right" class="health" :class="healthClass(c.health)">{{ c.health }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>

    <!-- ===================== CALL / TRANSCRIPT VIEWER ===================== -->
    <template v-else-if="view.name === 'call' && call">
      <div class="crumbs">
        <a @click="goOverview">Overview</a>
        <a @click="goAgent(call.call.agentId)">{{ call.agent.name }}</a>
        <span>{{ call.call.contactName }}</span>
      </div>
      <div class="split">
        <div class="card transcript">
          <h2>Transcript <span class="muted">— flagged segments highlighted</span></h2>
          <div v-for="(t,i) in call.call.transcript" :key="i" class="turn" :class="{ flag: turnFlagged(t) }">
            <div class="role">{{ t.role }}</div>
            <div><div>{{ t.text }}</div><div class="t">{{ t.tStart }}s–{{ t.tEnd }}s</div></div>
          </div>
        </div>
        <div>
          <div class="card">
            <h2>KPI checklist</h2>
            <ul class="checklist">
              <li><span class="dot" :class="call.result.kpis.goalCompleted ? 'g' : 'b'"></span> Goal completed</li>
              <li v-for="s in call.result.kpis.steps" :key="s.key">
                <span class="dot" :class="s.passed ? 'g' : 'b'"></span> {{ s.label }}
              </li>
              <li><span class="dot" :class="call.result.kpis.phoneCaptured ? 'g' : 'b'"></span> Callback number captured</li>
            </ul>
            <div class="meta">
              Sentiment: {{ call.result.kpis.sentiment.start }} → {{ call.result.kpis.sentiment.end }}
              ({{ call.result.kpis.sentiment.label }}) ·
              {{ call.result.kpis.turns }} turns · {{ call.result.kpis.durationSec }}s ·
              health <span class="health" :class="healthClass(call.result.health)">{{ call.result.health }}</span>
            </div>
          </div>
          <div class="card">
            <h2>Deviations</h2>
            <div v-if="!call.result.deviations.length" class="empty">None. Clean call.</div>
            <div v-for="(d,i) in call.result.deviations" :key="i" style="padding:8px 0;border-bottom:1px solid var(--line)">
              <span class="pill" :class="d.severity === 'high' ? 'bad' : d.severity === 'medium' ? 'warn' : 'mute'">{{ fmtType(d.type) }}</span>
              <div class="muted" style="margin-top:4px">{{ d.evidence }}</div>
              <div v-if="d.span" class="t">at {{ d.span.start }}s–{{ d.span.end }}s</div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>`
});

app.mount("#app");
