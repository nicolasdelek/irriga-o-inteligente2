const STORAGE_KEY = "irrigacao-config";
const EMBEDDED = false;  // false = abrir a página no PC/celular (usa IP e simulação); true = página servida pelo próprio ESP8266
const defaultConfig = {
ip: "192.168.1.50",
simulation: !EMBEDDED,          // true = interface roda sem hardware real
intervalo: 2,               // segundos entre consultas de status
umidadeMin: 40,
umidadeMax: 60,
nomeEstufa: "Estufa 1",
modoPadrao: "manual",
revezamentoSegundos: 180,   // tempo de cada relé antes de passar para o outro
};
function loadConfig() {
try {
const raw = localStorage.getItem(STORAGE_KEY);
if (!raw) return { ...defaultConfig };
return { ...defaultConfig, ...JSON.parse(raw) };
} catch (e) {
return { ...defaultConfig };
}
}
function saveConfig(cfg) {
localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}
let config = loadConfig();
const state = {
online: false,
wifi: false,
umidade: null,
irrigando: false,
modo: config.modoPadrao,      // "manual" | "automatico"
sensorErro: false,
historicoUmidade: [],          // { t: Date, valor: number }
historicoEventos: [],          // { t, acao, modo, umidade }
pollTimer: null,
commandInFlight: false,
releAtivo: 0,                 // 0 = nenhum, 1 ou 2
releFim: null,                // timestamp (ms) da próxima troca
};
const sim = {
umidade: 55,
bomba: false,
rele: 0,
fim: 0,
};
function simLigar() {
sim.bomba = true;
sim.rele = 1;
sim.fim = Date.now() + config.revezamentoSegundos * 1000;
}
function simDesligar() {
sim.bomba = false;
sim.rele = 0;
}
function simularCiclo() {
if (sim.bomba && Date.now() >= sim.fim) {
sim.rele = sim.rele === 1 ? 2 : 1;
sim.fim = Date.now() + config.revezamentoSegundos * 1000;
registrarEvento(`Relé ${sim.rele} ligado (revezamento)`, Math.round(sim.umidade));
}
const drift = sim.bomba ? (Math.random() * 2.2 + 0.6) : -(Math.random() * 0.7 + 0.15);
sim.umidade = Math.max(0, Math.min(100, sim.umidade + drift));
if (state.modo === "automatico") {
if (sim.umidade < config.umidadeMin && !sim.bomba) {
simLigar();
registrarEvento("Irrigação ligada", Math.round(sim.umidade));
} else if (sim.umidade >= config.umidadeMax && sim.bomba) {
simDesligar();
registrarEvento("Irrigação desligada", Math.round(sim.umidade));
}
}
return {
umidade: Math.round(sim.umidade),
irrigacao: sim.bomba,
modo: state.modo,
wifi: true,
sensor_ok: true,
rele_ativo: sim.rele,
rele_restante: sim.bomba ? Math.max(0, Math.round((sim.fim - Date.now()) / 1000)) : null,
};
}
async function chamarApi(caminho, opts = {}) {
const url = EMBEDDED ? caminho : `http://${config.ip}${caminho}`;
const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(3000) });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
return res.json();
}
async function buscarStatus() {
if (config.simulation) {
return simularCiclo();
}
return chamarApi("/api/status");
}
async function enviarComando(caminho, body) {
if (config.simulation) {
if (caminho === "/api/ligar") { simLigar(); registrarEvento("Irrigação ligada (manual)", Math.round(sim.umidade)); }
if (caminho === "/api/desligar") { simDesligar(); registrarEvento("Irrigação desligada (manual)", Math.round(sim.umidade)); }
if (caminho === "/api/automatico") state.modo = "automatico";
if (caminho === "/api/manual") state.modo = "manual";
return { ok: true };
}
return chamarApi(caminho, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: body ? JSON.stringify(body) : undefined,
});
}
async function atualizarStatus() {
try {
const data = await buscarStatus();
state.online = true;
state.wifi = !!data.wifi;
state.sensorErro = data.sensor_ok === false || data.umidade < 0 || data.umidade > 100;
state.umidade = state.sensorErro ? state.umidade : data.umidade;
state.irrigando = !!data.irrigacao;
state.modo = data.modo || state.modo;
state.adc = data.adc ?? null;
if (EMBEDDED && !state.sincronizado && data.umidade_min != null) {
config.umidadeMin = data.umidade_min;
config.umidadeMax = data.umidade_max;
if (data.revezamento_seg) config.revezamentoSegundos = data.revezamento_seg;
saveConfig(config);
preencherFormularios();
state.sincronizado = true;
}
state.releAtivo = state.irrigando ? (data.rele_ativo || 0) : 0;
state.releFim = (state.releAtivo && data.rele_restante != null) ? Date.now() + data.rele_restante * 1000 : null;
if (!state.sensorErro && typeof state.umidade === "number") {
state.historicoUmidade.push({ t: new Date(), valor: state.umidade });
if (state.historicoUmidade.length > 60) state.historicoUmidade.shift();
}
} catch (e) {
state.online = false;
}
render();
}
function iniciarPolling() {
if (state.pollTimer) clearInterval(state.pollTimer);
atualizarStatus();
state.pollTimer = setInterval(atualizarStatus, Math.max(1, config.intervalo) * 1000);
}
function registrarEvento(acao, umidade) {
const evento = { t: new Date(), acao, modo: state.modo, umidade };
state.historicoEventos.unshift(evento);
if (state.historicoEventos.length > 100) state.historicoEventos.pop();
renderEventos();
renderHistoricoTabela();
}
function formatHora(d) {
return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
function toast(msg, tipo = "ok") {
const stack = document.getElementById("toast-stack");
const el = document.createElement("div");
el.className = `toast ${tipo === "warn" ? "toast--warn" : tipo === "bad" ? "toast--bad" : ""}`;
el.textContent = msg;
stack.appendChild(el);
setTimeout(() => el.remove(), 4200);
}
function render() {
const pillEsp = document.getElementById("pill-esp32");
const pillWifi = document.getElementById("pill-wifi");
pillEsp.className = `pill ${state.online ? "pill--ok" : "pill--bad"}`;
pillEsp.innerHTML = `<i class="dot"></i><span>ESP32 ${state.online ? "conectado" : "desconectado"}</span>`;
pillWifi.className = `pill ${state.wifi ? "pill--ok" : "pill--bad"}`;
pillWifi.innerHTML = `<i class="dot"></i><span>Wi-Fi ${state.wifi ? "conectado" : "desconectado"}</span>`;
document.getElementById("offline-banner").hidden = state.online;
const valor = state.umidade ?? 0;
document.getElementById("umidade-valor").textContent = state.umidade === null ? "--%" : `${valor}%`;
document.getElementById("umidade-fill").style.width = `${valor}%`;
document.getElementById("marker-min").style.left = `${config.umidadeMin}%`;
document.getElementById("marker-max").style.left = `${config.umidadeMax}%`;
const flag = document.getElementById("sensor-flag");
flag.textContent = state.sensorErro ? "erro no sensor" : "normal";
flag.classList.toggle("is-erro", state.sensorErro);
document.getElementById("adc-raw").textContent = state.adc == null ? "" : `Leitura bruta do sensor (A0): ${state.adc}`;
const card = document.getElementById("card-irrigacao");
card.classList.toggle("is-on", state.irrigando);
document.getElementById("irrigacao-estado").textContent = state.irrigando ? "Irrigando" : "Desligada";
document.getElementById("modo-label").textContent = state.modo === "automatico" ? "Automático" : "Manual";
const modoAuto = state.modo === "automatico";
document.getElementById("btn-modo").classList.toggle("is-active", modoAuto);
document.getElementById("btn-modo-label").textContent = modoAuto ? "Voltar ao modo manual" : "Ativar modo automático";
document.getElementById("btn-ligar").disabled = !state.online || modoAuto || state.irrigando;
document.getElementById("btn-desligar").disabled = !state.online || modoAuto || !state.irrigando;
document.getElementById("controles-hint").textContent = modoAuto
? "O modo automático está ativo: o ESP32 liga e desliga a bomba sozinho, conforme os limites configurados."
: "No modo manual, você controla a bomba diretamente pelos botões acima.";
renderRevezamento();
desenharGrafico();
}
function renderRevezamento() {
const ativo = state.releAtivo;
document.getElementById("card-revezamento").classList.toggle("is-on", !!ativo);
document.getElementById("rev-flag").textContent = ativo ? `relé ${ativo} ligado` : "parado";
document.getElementById("rev-desc").textContent = ativo
? `Cada relé fica ligado ${fmtDur(config.revezamentoSegundos)}. Próxima troca em:`
: "Com a irrigação ligada, os relés se revezam a cada intervalo.";
[1, 2].forEach(n => {
const el = document.getElementById(`rev-${n}`);
el.classList.toggle("is-on", ativo === n);
el.querySelector("small span").textContent = ativo === n ? "ligado" : "aguardando";
});
document.getElementById("btn-salvar-rev").disabled = !state.online;
renderRevTimer();
}
function renderRevTimer() {
const el = document.getElementById("rev-timer");
if (!state.releAtivo || !state.releFim) { el.textContent = "--:--"; return; }
const s = Math.max(0, Math.round((state.releFim - Date.now()) / 1000));
el.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function fmtDur(t) {
const m = Math.floor(t / 60), r = t % 60;
return m ? (r ? `${m} min ${r} s` : `${m} min`) : `${r} s`;
}
function atualizarSaidaRev() {
document.getElementById("out-rev-min").textContent = `${document.getElementById("range-rev-min").value} min`;
document.getElementById("out-rev-seg").textContent = `${document.getElementById("range-rev-seg").value} s`;
}
function preencherRevezamento() {
const t = config.revezamentoSegundos;
document.getElementById("range-rev-min").value = Math.floor(t / 60);
document.getElementById("range-rev-seg").value = t % 60;
atualizarSaidaRev();
}
async function salvarRevezamento() {
const total = Number(document.getElementById("range-rev-min").value) * 60 + Number(document.getElementById("range-rev-seg").value);
if (total < 5) { toast("O tempo mínimo de cada relé é 5 segundos.", "warn"); return; }
config.revezamentoSegundos = total;
saveConfig(config);
if (config.simulation && sim.bomba) sim.fim = Date.now() + total * 1000;
try {
await enviarComando("/api/config", { revezamentoSegundos: total });
toast(`Cada relé ficará ligado ${fmtDur(total)}.`);
await atualizarStatus();
} catch (e) {
toast("Tempo salvo localmente, mas o ESP32 não confirmou.", "warn");
}
}
function renderEventos() {
const lista = document.getElementById("eventos-lista");
if (state.historicoEventos.length === 0) {
lista.innerHTML = `<li class="evento evento--vazio">Nenhum evento registrado ainda.</li>`;
return;
}
lista.innerHTML = state.historicoEventos.slice(0, 6).map(ev => `
<li class="evento">
<span>${ev.acao}</span>
<span class="evento__time">${formatHora(ev.t)} · ${ev.umidade}%</span>
</li>
`).join("");
}
function renderHistoricoTabela() {
const body = document.getElementById("tabela-historico-body");
if (state.historicoEventos.length === 0) {
body.innerHTML = `<tr><td colspan="4" class="tabela__vazio">Sem registros por enquanto.</td></tr>`;
return;
}
body.innerHTML = state.historicoEventos.map(ev => `
<tr>
<td>${formatHora(ev.t)}</td>
<td>${ev.acao}</td>
<td>${ev.modo === "automatico" ? "Automático" : "Manual"}</td>
<td>${ev.umidade}%</td>
</tr>
`).join("");
}
function desenharGrafico() {
const canvas = document.getElementById("grafico-umidade");
const ctx = canvas.getContext("2d");
const dpr = window.devicePixelRatio || 1;
const cssWidth = canvas.clientWidth || 400;
const cssHeight = 160;
canvas.width = cssWidth * dpr;
canvas.height = cssHeight * dpr;
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
ctx.clearRect(0, 0, cssWidth, cssHeight);
const pontos = state.historicoUmidade;
const pad = 24;
ctx.strokeStyle = "rgba(159,182,165,0.15)";
ctx.lineWidth = 1;
[0, 25, 50, 75, 100].forEach(pct => {
const y = pad + (1 - pct / 100) * (cssHeight - pad * 1.4);
ctx.beginPath();
ctx.moveTo(pad, y);
ctx.lineTo(cssWidth - 8, y);
ctx.stroke();
});
if (pontos.length < 2) {
ctx.fillStyle = "#6C8375";
ctx.font = "13px 'IBM Plex Sans', sans-serif";
ctx.fillText("Aguardando leituras...", pad, cssHeight / 2);
return;
}
const xStep = (cssWidth - pad - 8) / (pontos.length - 1);
const yFor = (v) => pad + (1 - v / 100) * (cssHeight - pad * 1.4);
ctx.beginPath();
pontos.forEach((p, i) => {
const x = pad + i * xStep;
const y = yFor(p.valor);
if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
});
ctx.strokeStyle = "#4FA8D8";
ctx.lineWidth = 2;
ctx.stroke();
ctx.lineTo(pad + (pontos.length - 1) * xStep, cssHeight - pad * 0.4);
ctx.lineTo(pad, cssHeight - pad * 0.4);
ctx.closePath();
ctx.fillStyle = "rgba(79,168,216,0.12)";
ctx.fill();
}
function irPara(pagina) {
document.querySelectorAll(".app > .page").forEach(p => p.classList.toggle("page--active", p.dataset.page === pagina));
document.querySelectorAll(".navlink").forEach(n => n.classList.toggle("navlink--active", n.dataset.nav === pagina));
document.getElementById("main-nav").classList.remove("is-open");
window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
}
async function ligar() {
if (state.commandInFlight) return;
state.commandInFlight = true;
try {
await enviarComando("/api/ligar");
toast("Irrigação ligada com sucesso.");
await atualizarStatus();
} catch (e) {
toast("Não foi possível ligar a bomba.", "bad");
} finally {
state.commandInFlight = false;
}
}
async function desligar() {
if (state.commandInFlight) return;
state.commandInFlight = true;
try {
await enviarComando("/api/desligar");
toast("Irrigação desligada com sucesso.");
await atualizarStatus();
} catch (e) {
toast("Não foi possível desligar a bomba.", "bad");
} finally {
state.commandInFlight = false;
}
}
async function alternarModo() {
const novoModo = state.modo === "automatico" ? "manual" : "automatico";
try {
await enviarComando(novoModo === "automatico" ? "/api/automatico" : "/api/manual");
state.modo = novoModo;
toast(novoModo === "automatico" ? "Modo automático ativado." : "Modo manual ativado.");
await atualizarStatus();
} catch (e) {
toast("Falha na comunicação com o ESP32.", "bad");
}
}
async function salvarLimites() {
config.umidadeMin = Number(document.getElementById("range-min").value);
config.umidadeMax = Number(document.getElementById("range-max").value);
saveConfig(config);
try {
await enviarComando("/api/config", { umidadeMin: config.umidadeMin, umidadeMax: config.umidadeMax });
toast("Limites de umidade salvos.");
} catch (e) {
toast("Limites salvos localmente, mas o ESP32 não confirmou.", "warn");
}
render();
}
function salvarConfiguracoes() {
config.nomeEstufa = document.getElementById("cfg-nome").value || defaultConfig.nomeEstufa;
config.umidadeMin = Number(document.getElementById("cfg-min").value);
config.umidadeMax = Number(document.getElementById("cfg-max").value);
config.intervalo = Number(document.getElementById("cfg-intervalo").value) || defaultConfig.intervalo;
config.modoPadrao = document.getElementById("cfg-modo-padrao").value;
saveConfig(config);
enviarComando("/api/config", { umidadeMin: config.umidadeMin, umidadeMax: config.umidadeMax, modoPadrao: config.modoPadrao })
.catch(() => toast("Salvo localmente, mas o ESP32 não confirmou o intervalo.", "warn"));
toast("Configurações salvas.");
iniciarPolling();
}
function salvarConexao() {
config.ip = document.getElementById("cfg-ip").value.trim() || defaultConfig.ip;
config.simulation = document.getElementById("cfg-simulacao").checked;
saveConfig(config);
toast(config.simulation ? "Modo simulação ativado." : `Tentando conectar ao ESP32 em ${config.ip}...`);
iniciarPolling();
}
function preencherFormularios() {
document.getElementById("range-min").value = config.umidadeMin;
document.getElementById("range-max").value = config.umidadeMax;
document.getElementById("out-min").textContent = `${config.umidadeMin}%`;
document.getElementById("out-max").textContent = `${config.umidadeMax}%`;
document.getElementById("cfg-nome").value = config.nomeEstufa;
document.getElementById("cfg-min").value = config.umidadeMin;
document.getElementById("cfg-max").value = config.umidadeMax;
document.getElementById("cfg-intervalo").value = config.intervalo;
document.getElementById("cfg-modo-padrao").value = config.modoPadrao;
preencherRevezamento();
document.getElementById("cfg-ip").value = config.ip;
document.getElementById("cfg-simulacao").checked = config.simulation;
}
function ligarEventos() {
document.getElementById("btn-acessar").addEventListener("click", () => {
document.getElementById("capa").classList.remove("page--active");
document.getElementById("app").classList.add("app--active");
iniciarPolling();
});
document.querySelectorAll("[data-nav]").forEach(el => {
el.addEventListener("click", () => irPara(el.dataset.nav));
});
document.getElementById("burger").addEventListener("click", () => {
document.getElementById("main-nav").classList.toggle("is-open");
});
document.getElementById("btn-ligar").addEventListener("click", ligar);
document.getElementById("btn-desligar").addEventListener("click", desligar);
document.getElementById("btn-modo").addEventListener("click", alternarModo);
setInterval(renderRevTimer, 1000);
document.getElementById("range-rev-min").addEventListener("input", atualizarSaidaRev);
document.getElementById("range-rev-seg").addEventListener("input", atualizarSaidaRev);
document.getElementById("btn-salvar-rev").addEventListener("click", salvarRevezamento);
const rangeMin = document.getElementById("range-min");
const rangeMax = document.getElementById("range-max");
rangeMin.addEventListener("input", () => document.getElementById("out-min").textContent = `${rangeMin.value}%`);
rangeMax.addEventListener("input", () => document.getElementById("out-max").textContent = `${rangeMax.value}%`);
document.getElementById("btn-salvar-limites").addEventListener("click", salvarLimites);
document.getElementById("btn-salvar-config").addEventListener("click", salvarConfiguracoes);
document.getElementById("btn-salvar-ip").addEventListener("click", salvarConexao);
window.addEventListener("resize", desenharGrafico);
}
document.addEventListener("DOMContentLoaded", () => {
preencherFormularios();
ligarEventos();
});
