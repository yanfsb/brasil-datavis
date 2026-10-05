import { correlationSentence, formatNumber, pearson } from "./stats.ts";
import {
  advantageColor,
  buildSpatialGrid,
  contains,
  fitView,
  flatPartyColor,
  indicatorColor,
  intersectsView,
  leaderOf,
  pointInRing,
  querySpatialGrid,
  ringBBox,
  screenTransform,
  stateOutlineWidth,
  zoomAt,
  type BBox,
  type Leader,
  type SpatialGrid,
} from "./mapdraw.ts";

interface Mun {
  readonly ibge: string;
  readonly nome: string;
  readonly uf: string;
  readonly fp: number;
  readonly lp: number;
  readonly fv: number;
  readonly lv: number;
  readonly vv: number;
  readonly ap: number;
  readonly ab: number;
  readonly analfabetismo: number | null;
  readonly esgoto: number | null;
  readonly agua?: number | null;
  readonly lixo?: number | null;
  readonly internet?: number | null;
  readonly renda: number | null;
  readonly pib?: number | null;
  readonly densidade?: number | null;
  readonly populacao?: number | null;
  readonly g: readonly (readonly (readonly number[])[])[];
}

interface MapFile {
  readonly fonte?: string;
  readonly width: number;
  readonly height: number;
  readonly brasil: { readonly fp: number; readonly lp: number; readonly fv: number; readonly lv: number; readonly vv: number; readonly ap: number; readonly ab: number };
  readonly ufIndicadores: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly mun: readonly Mun[];
  readonly estados?: readonly { readonly ibge: string; readonly g: Mun["g"] }[];
}

interface Drawable {
  readonly mun: Mun;
  readonly path: Path2D;
  readonly box: BBox;
  readonly leader: Leader;
  readonly margem: number;
  fills: Record<string, string>;
}

const INDICATORS = [
  { id: "analfabetismo", nome: "Analfabetismo", unidade: "%", ano: "Censo 2022" },
  { id: "esgoto", nome: "Esgoto", unidade: "%", ano: "Censo 2022" },
  { id: "agua", nome: "Água da rede", unidade: "%", ano: "Censo 2022" },
  { id: "lixo", nome: "Lixo coletado", unidade: "%", ano: "Censo 2022" },
  { id: "internet", nome: "Internet", unidade: "%", ano: "Censo 2022" },
  { id: "renda", nome: "Renda", unidade: "R$", ano: "Censo 2022" },
  { id: "pib", nome: "PIB per capita", unidade: "R$", ano: "2023" },
  { id: "densidade", nome: "Densidade", unidade: "hab/km²", ano: "Censo 2022" },
  { id: "abstencao", nome: "Abstenção", unidade: "%", ano: "TSE 2026" },
] as const;

type IndicatorId = (typeof INDICATORS)[number]["id"];
type Mode = "municipios" | "estados" | "vantagem" | IndicatorId;

const REGIAO: Readonly<Record<string, string>> = {
  AC: "Norte", AM: "Norte", AP: "Norte", PA: "Norte", RO: "Norte", RR: "Norte", TO: "Norte",
  AL: "Nordeste", BA: "Nordeste", CE: "Nordeste", MA: "Nordeste", PB: "Nordeste", PE: "Nordeste", PI: "Nordeste", RN: "Nordeste", SE: "Nordeste",
  DF: "Centro-Oeste", GO: "Centro-Oeste", MT: "Centro-Oeste", MS: "Centro-Oeste",
  ES: "Sudeste", MG: "Sudeste", RJ: "Sudeste", SP: "Sudeste",
  PR: "Sul", RS: "Sul", SC: "Sul",
};

const app = document.querySelector("#app");
if (!(app instanceof HTMLElement)) throw new Error("missing app root");

void boot(app);

async function boot(root: HTMLElement): Promise<void> {
  try {
    const response = await fetch("/data/map.json");
    if (!response.ok) throw new Error("O mapa municipal ainda não foi gerado. Rode python3 scripts/build_map.py.");
    mount(root, (await response.json()) as MapFile);
  } catch (error) {
    root.textContent = error instanceof Error ? error.message : "Falha ao abrir o mapa.";
  }
}

function mount(root: HTMLElement, data: MapFile): void {
  const drawables = data.mun.map(toDrawable);
  const statePaths = (data.estados ?? []).map((state) => toPath(state.g));
  const byUf = aggregate(drawables);
  const ranges = Object.fromEntries(INDICATORS.map((item) => [item.id, extent(drawables, item.id)])) as Record<IndicatorId, [number, number]>;
  assignFills(drawables, byUf, ranges);
  const grid = buildSpatialGrid(drawables, 220);
  const counts = {
    flavio: drawables.filter((item) => item.leader === "flavio").length,
    lula: drawables.filter((item) => item.leader === "lula").length,
  };
  let voteMode: "municipios" | "estados" | "vantagem" = "municipios";
  let indicator: IndicatorId | null = null;
  const currentMode = (): Mode => indicator ?? voteMode;
  let selected: Drawable | null = null;
  let hovered: Drawable | null = null;
  let query = "";
  const view = fitView(data.width, data.height, window.innerWidth, window.innerHeight, mapInset(window.innerWidth));
  let dragging = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;

  root.innerHTML = shell();
  const stage = required("#stage");
  const base = requiredCanvas("#base");
  const overlay = requiredCanvas("#overlay");
  const baseCtx = base.getContext("2d");
  const overlayCtx = overlay.getContext("2d");
  if (!baseCtx || !overlayCtx) throw new Error("canvas indisponível");

  const cache = document.createElement("canvas");
  const cacheCtx = cache.getContext("2d");
  if (!cacheCtx) throw new Error("canvas indisponível");
  let sharp: { scale: number; panX: number; panY: number; dpr: number } | null = null;
  let settle = 0;
  let fastQueued = false;

  const resize = (): void => {
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    for (const canvas of [base, overlay]) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    sharp = null;
    paintSharp();
  };

  const paintSharp = (): void => {
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    base.width = base.width;
    const countryScale = fitView(data.width, data.height, rect.width, rect.height, mapInset(rect.width)).scale;
    paint(baseCtx, drawables, statePaths, byUf, currentMode(), rect.width, rect.height, dpr, view, countryScale);
    if (cache.width !== base.width || cache.height !== base.height) {
      cache.width = base.width;
      cache.height = base.height;
    }
    cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
    cacheCtx.drawImage(base, 0, 0);
    sharp = { scale: view.scale, panX: view.panX, panY: view.panY, dpr };
    paintHighlight(overlayCtx, selected, hovered, rect.width, rect.height, dpr, view);
  };
  const paintFast = (): void => {
    if (!sharp || sharp.dpr !== (window.devicePixelRatio || 1)) {
      paintSharp();
      return;
    }
    const mapped = screenTransform(sharp, view);
    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.fillStyle = "#0c0e13";
    baseCtx.fillRect(0, 0, base.width, base.height);
    baseCtx.imageSmoothingEnabled = mapped.scale !== 1;
    baseCtx.setTransform(mapped.scale, 0, 0, mapped.scale, mapped.x * sharp.dpr, mapped.y * sharp.dpr);
    baseCtx.drawImage(cache, 0, 0);
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  };
  const requestFast = (): void => {
    if (fastQueued) return;
    fastQueued = true;
    requestAnimationFrame(() => {
      fastQueued = false;
      paintFast();
    });
  };
  const settleSharp = (): void => {
    window.clearTimeout(settle);
    settle = window.setTimeout(() => paintSharp(), 90);
  };

  const renderPanels = (): void => {
    required("#left-panel").innerHTML = selected ? placePanel(selected.mun, data) : countryPanel(data, counts);
    const mode = currentMode();
    required("#right-panel").innerHTML = indicatorMode(mode) ? correlationPanel(data, drawables, mode, selected) : regionPanel(byUf);
    required("#legend").innerHTML = legend(mode, counts, ranges);
    required("#status").textContent = `${formatNumber(data.brasil.ap, 0)}% das seções · ${drawables.length.toLocaleString("pt-BR")} municípios`;
    const results = required("#search-results");
    const matches = search(drawables, query);
    results.hidden = query.length < 2 || matches.length === 0;
    results.innerHTML = matches.map((item) => `<button type="button" data-action="pick" data-ibge="${item.mun.ibge}">${escapeHtml(item.mun.nome)}<span>${item.mun.uf}</span></button>`).join("");
    document.querySelectorAll("[data-action='vote']").forEach((button) => {
      button.setAttribute("aria-pressed", String(indicator === null && button.getAttribute("data-mode") === voteMode));
    });
  };

  const locate = (x: number, y: number): Drawable | null => hit(grid, x, y);
  const pick = (item: Drawable | null, focus: boolean): void => {
    selected = item;
    if (item && focus) {
      focusOn(item.box, stage, view);
      requestFast();
      settleSharp();
    } else {
      const rect = stage.getBoundingClientRect();
      paintHighlight(overlayCtx, selected, hovered, rect.width, rect.height, window.devicePixelRatio || 1, view);
    }
    renderPanels();
  };

  overlay.addEventListener("pointerdown", (event) => {
    window.clearTimeout(settle);
    dragging = true;
    moved = false;
    lastX = event.clientX;
    lastY = event.clientY;
    overlay.setPointerCapture(event.pointerId);
  });
  overlay.addEventListener("pointermove", (event) => {
    const rect = overlay.getBoundingClientRect();
    if (dragging) {
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      if (Math.hypot(dx, dy) > 3) moved = true;
      view.panX += dx;
      view.panY += dy;
      lastX = event.clientX;
      lastY = event.clientY;
      requestFast();
      return;
    }
    const world = toWorld(event.clientX - rect.left, event.clientY - rect.top, view);
    const next = locate(world.x, world.y);
    if (next !== hovered) {
      hovered = next;
      paintHighlight(overlayCtx, selected, hovered, rect.width, rect.height, window.devicePixelRatio || 1, view);
    }
    moveTooltip(event.clientX, event.clientY, next);
  });
  overlay.addEventListener("pointerup", (event) => {
    dragging = false;
    if (moved) {
      paintSharp();
      return;
    }
    const rect = overlay.getBoundingClientRect();
    const world = toWorld(event.clientX - rect.left, event.clientY - rect.top, view);
    pick(locate(world.x, world.y), false);
  });
  overlay.addEventListener("pointerleave", () => {
    hovered = null;
    required("#tooltip").hidden = true;
    const rect = stage.getBoundingClientRect();
    paintHighlight(overlayCtx, selected, null, rect.width, rect.height, window.devicePixelRatio || 1, view);
  });
  overlay.addEventListener("dblclick", (event) => {
    const rect = overlay.getBoundingClientRect();
    const world = toWorld(event.clientX - rect.left, event.clientY - rect.top, view);
    const item = locate(world.x, world.y);
    if (item) pick(item, true);
  });
  const countryView = (): { scale: number; panX: number; panY: number } =>
    fitView(data.width, data.height, stage.clientWidth, stage.clientHeight, mapInset(stage.clientWidth));
  const applyZoom = (factor: number, cursorX: number, cursorY: number): void => {
    const fitted = countryView();
    const next = zoomAt(view.scale, view.panX, view.panY, cursorX, cursorY, factor, {
      min: fitted.scale,
      max: Math.min(8, fitted.scale * 80),
    });
    if (next.scale <= fitted.scale * 1.02) Object.assign(view, fitted);
    else Object.assign(view, next);
    requestFast();
    settleSharp();
  };

  overlay.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = overlay.getBoundingClientRect();
    applyZoom(event.deltaY < 0 ? 1.12 : 0.89, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });

  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (!target) return;
    const action = target.getAttribute("data-action");
    if (action === "vote") {
      const next = target.getAttribute("data-mode");
      if (next === "municipios" || next === "estados" || next === "vantagem") voteMode = next;
      indicator = null;
      requiredSelect("#indicator-select").value = "";
      renderPanels();
      paintSharp();
      return;
    }
    if (action === "zoom") {
      const rect = stage.getBoundingClientRect();
      applyZoom(target.getAttribute("data-factor") === "in" ? 1.25 : 0.8, rect.width / 2, rect.height / 2);
      return;
    }
    if (action === "reset") {
      Object.assign(view, countryView());
      requestFast();
      settleSharp();
      return;
    }
    if (action === "clear") {
      selected = null;
      renderPanels();
      const rect = stage.getBoundingClientRect();
      paintHighlight(overlayCtx, null, hovered, rect.width, rect.height, window.devicePixelRatio || 1, view);
      return;
    }
    if (action === "pick") {
      const item = drawables.find((drawable) => drawable.mun.ibge === target.getAttribute("data-ibge")) ?? null;
      query = "";
      requiredInput("#search").value = item ? `${item.mun.nome} · ${item.mun.uf}` : "";
      pick(item, true);
      return;
    }
    renderPanels();
    paintSharp();
  });
  required("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const [first] = search(drawables, query);
    if (!first) return;
    query = "";
    requiredInput("#search").value = `${first.mun.nome} · ${first.mun.uf}`;
    pick(first, true);
  });
  requiredInput("#search").addEventListener("input", (event) => {
    query = event.target instanceof HTMLInputElement ? event.target.value : "";
    renderPanels();
  });
  requiredSelect("#indicator-select").addEventListener("change", (event) => {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : "";
    indicator = INDICATORS.find((item) => item.id === value)?.id ?? null;
    renderPanels();
    paintSharp();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      selected = null;
      renderPanels();
      const rect = stage.getBoundingClientRect();
      paintHighlight(overlayCtx, null, hovered, rect.width, rect.height, window.devicePixelRatio || 1, view);
    }
  });
  new ResizeObserver(resize).observe(stage);
  resize();
  renderPanels();
}

function paint(
  ctx: CanvasRenderingContext2D,
  drawables: readonly Drawable[],
  statePaths: readonly Path2D[],
  byUf: ReadonlyMap<string, UfAgg>,
  mode: Mode,
  width: number,
  height: number,
  dpr: number,
  view: { scale: number; panX: number; panY: number },
  countryScale: number,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width * dpr, height * dpr);
  ctx.fillStyle = "#0c0e13";
  ctx.fillRect(0, 0, width * dpr, height * dpr);
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.panX, dpr * view.panY);
  const strokeMunicipal = mode === "municipios" && view.scale >= 0.2;
  const strokeWidth = (mode === "estados" ? 1.4 : 0.7) / view.scale;
  for (const item of drawables) {
    if (!intersectsView(item.box, view, width, height)) continue;
    ctx.fillStyle = item.fills[mode];
    ctx.fill(item.path, "evenodd");
    if (mode === "vantagem" || (!strokeMunicipal && mode !== "estados")) continue;
    ctx.strokeStyle = mode === "estados" ? item.fills.estados : "rgba(8, 9, 12, 0.55)";
    ctx.lineWidth = strokeWidth;
    ctx.stroke(item.path);
  }
  ctx.strokeStyle = "#000";
  ctx.lineWidth = stateOutlineWidth(view.scale, countryScale);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const path of statePaths) ctx.stroke(path);
  drawStateLabels(ctx, byUf, dpr, view);
}

function mapInset(width: number): { top: number; right: number; bottom: number; left: number } {
  if (width < 860) return { top: 88, right: 12, bottom: 250, left: 12 };
  return { top: 78, right: 28, bottom: 58, left: 28 };
}

function drawStateLabels(
  ctx: CanvasRenderingContext2D,
  byUf: ReadonlyMap<string, UfAgg>,
  dpr: number,
  view: { scale: number; panX: number; panY: number },
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  for (const uf of [...byUf.values()].sort((left, right) => right.vv - left.vv)) {
    const screenWidth = (uf.maxX - uf.minX) * view.scale;
    if (screenWidth < 52) continue;
    const x = view.panX + uf.x * view.scale;
    const y = view.panY + uf.y * view.scale;
    const box = { x: x - 22, y: y - 16, w: 44, h: 32 };
    if (placed.some((item) => intersects(item, box))) continue;
    placed.push(box);
    ctx.fillStyle = "#f8f5ef";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "600 13px sans-serif";
    ctx.fillText(uf.sigla, x, y - 7);
    ctx.font = "12px sans-serif";
    ctx.fillText(`${formatNumber(uf.leader === "lula" ? uf.lp : uf.fp, 0)}%`, x, y + 8);
  }
}

function intersects(
  left: { x: number; y: number; w: number; h: number },
  right: { x: number; y: number; w: number; h: number },
): boolean {
  return left.x < right.x + right.w && left.x + left.w > right.x && left.y < right.y + right.h && left.y + left.h > right.y;
}

function paintHighlight(
  ctx: CanvasRenderingContext2D,
  selected: Drawable | null,
  hovered: Drawable | null,
  width: number,
  height: number,
  dpr: number,
  view: { scale: number; panX: number; panY: number },
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width * dpr, height * dpr);
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.panX, dpr * view.panY);
  for (const item of [hovered, selected]) {
    if (!item) continue;
    ctx.strokeStyle = "#f8f5ef";
    ctx.lineWidth = 2.2 / view.scale;
    ctx.stroke(item.path);
  }
}

function assignFills(
  drawables: readonly Drawable[],
  byUf: ReadonlyMap<string, UfAgg>,
  ranges: Record<IndicatorId, [number, number]>,
): void {
  for (const item of drawables) {
    const uf = byUf.get(item.mun.uf);
    const fills: Record<string, string> = {
      municipios: flatPartyColor(item.leader),
      vantagem: advantageColor(item.leader, item.margem),
      estados: uf ? flatPartyColor(uf.leader) : "#3a3f46",
    };
    for (const indicator of INDICATORS) {
      fills[indicator.id] = paintIndicator(indicatorValue(item.mun, indicator.id), ranges[indicator.id]);
    }
    item.fills = fills;
  }
}

function paintIndicator(value: number | null, range: [number, number]): string {
  if (value === null) return "#2a2e36";
  return indicatorColor(value, range[0], range[1]);
}

function countryPanel(data: MapFile, counts: { flavio: number; lula: number }): string {
  const others = Math.max(0, 100 - data.brasil.fp - data.brasil.lp);
  return `
    <p class="kicker">Presidente · Brasil</p>
    <h1>Flávio e Lula vão ao 2º turno</h1>
    <div class="pair">
      <div class="lula"><span class="unit">Lula · PT</span><span class="pct">${formatNumber(data.brasil.lp, 2)}%</span><span class="fine">${data.brasil.lv.toLocaleString("pt-BR")} votos</span></div>
      <div class="flavio"><span class="unit">Flávio · PL</span><span class="pct">${formatNumber(data.brasil.fp, 2)}%</span><span class="fine">${data.brasil.fv.toLocaleString("pt-BR")} votos</span></div>
    </div>
    <div class="split" aria-hidden="true"><i class="lula" style="width:${data.brasil.lp}%"></i><i class="flavio" style="width:${data.brasil.fp}%"></i></div>
    <p class="fine">Diferença de ${formatNumber(data.brasil.fp - data.brasil.lp, 2)} pontos. Outros válidos ${formatNumber(others, 1)}%. Abstenção ${formatNumber(data.brasil.ab, 1)}%.</p>
    <p class="fine">PL em ${counts.flavio.toLocaleString("pt-BR")} municípios · PT em ${counts.lula.toLocaleString("pt-BR")}. Arraste o mapa, use a roda para aproximar e clique um município.</p>`;
}

function placePanel(mun: Mun, data: MapFile): string {
  const leader = leaderOf(mun.fv, mun.lv);
  const uf = data.ufIndicadores[mun.uf];
  return `
    <p class="kicker">${escapeHtml(mun.uf)} · ${escapeHtml(REGIAO[mun.uf] ?? "")}</p>
    <div class="section-head"><h1>${escapeHtml(mun.nome)}</h1><button class="text-button" type="button" data-action="clear">fechar</button></div>
    <p class="fine">${leaderLabel(leader)} lidera por ${formatNumber(Math.abs(mun.fp - mun.lp), 1)} pontos.</p>
    <div class="pair">
      <div class="lula"><span class="unit">Lula</span><span class="pct">${formatNumber(mun.lp, 1)}%</span></div>
      <div class="flavio"><span class="unit">Flávio</span><span class="pct">${formatNumber(mun.fp, 1)}%</span></div>
    </div>
    <p class="fine">${mun.populacao ? `${Math.round(mun.populacao).toLocaleString("pt-BR")} habitantes · ` : ""}${mun.vv.toLocaleString("pt-BR")} votos válidos · ${formatNumber(mun.ap, 0)}% das seções.</p>
    <div class="bars">
      ${INDICATORS.map((indicator) => indicatorRow(indicator, indicatorValue(mun, indicator.id), uf?.[indicator.id])).join("")}
    </div>
    <p class="fine">A barra compara o município com o valor da UF, quando ele existe na mesma fonte.</p>`;
}

function correlationPanel(data: MapFile, drawables: readonly Drawable[], mode: Mode, selected: Drawable | null): string {
  const meta = INDICATORS.find((item) => item.id === mode);
  const id = meta?.id ?? "analfabetismo";
  const rows = drawables.filter((item) => indicatorValue(item.mun, id) !== null);
  const line = pearson(rows.map((item) => indicatorValue(item.mun, id) as number), rows.map((item) => item.margem));
  const here = selected ? indicatorValue(selected.mun, id) : null;
  return `
    <p class="kicker">${escapeHtml(meta?.nome ?? "")} · ${escapeHtml(meta?.ano ?? "")}</p>
    <h2>r ${formatNumber(line.r, 2)}</h2>
    <p class="fine">${escapeHtml(correlationSentence(meta?.nome.toLowerCase() ?? "indicador", line, "municípios"))} Cada município pesa igual, não cada eleitor.</p>
    <p class="fine">${here === null || here === undefined ? "Clique um município para ver o valor local." : `${selected?.mun.nome}: ${formatIndicator(id, here)}.`} ${rows.length.toLocaleString("pt-BR")} municípios com dado.</p>
    <p class="fine">Votos do TSE e malha do IBGE. Correlação territorial não explica o voto individual.</p>`;
}

function regionPanel(byUf: ReadonlyMap<string, UfAgg>): string {
  const grouped = new Map<string, { fv: number; lv: number; vv: number }>();
  for (const uf of byUf.values()) {
    const region = REGIAO[uf.sigla] ?? "Outras";
    const current = grouped.get(region) ?? { fv: 0, lv: 0, vv: 0 };
    current.fv += uf.fv;
    current.lv += uf.lv;
    current.vv += uf.vv;
    grouped.set(region, current);
  }
  const order = ["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul"];
  return `
    <p class="kicker">Por região</p>
    <h2>Quem lidera</h2>
    <div class="region-list">
      ${order.map((region) => {
        const item = grouped.get(region);
        if (!item) return "";
        const flavio = item.vv ? (100 * item.fv) / item.vv : 0;
        const lula = item.vv ? (100 * item.lv) / item.vv : 0;
        const leader = flavio >= lula ? "PL" : "PT";
        const share = Math.max(flavio, lula);
        return `<article><span>${region}</span><b class="${leader === "PL" ? "flavio" : "lula"}">${leader} ${formatNumber(share, 1)}%</b></article>`;
      }).join("")}
    </div>
    <p class="fine">Soma dos votos de Flávio e Lula nos municípios do mapa. Não inclui o exterior.</p>`;
}

function legend(mode: Mode, counts: { flavio: number; lula: number }, ranges: Record<IndicatorId, [number, number]>): string {
  if (isIndicator(mode)) {
    const [min, max] = ranges[mode];
    return `<span>${formatIndicator(mode, min)}</span><i class="swatch" style="background:linear-gradient(90deg,#4e8ea8,#e07a46)"></i><span>${formatIndicator(mode, max)}</span>`;
  }
  if (mode === "vantagem") {
    return `<span>apertada</span><i class="swatch" style="background:linear-gradient(90deg,#e8e2d8,#e23b55)"></i><i class="swatch" style="background:linear-gradient(90deg,#e8e2d8,#2f74f5)"></i><span>45 pontos ou mais</span>`;
  }
  return `<span class="lula">PT ${counts.lula.toLocaleString("pt-BR")}</span><span class="flavio">PL ${counts.flavio.toLocaleString("pt-BR")}</span><span>${mode === "estados" ? "uma cor por UF" : "cor chapada do vencedor"}</span>`;
}

function shell(): string {
  return `
    <main class="stage" id="stage">
      <canvas id="base"></canvas>
      <canvas id="overlay"></canvas>
      <header class="topbar">
        <strong class="brand">Chão e urna <span>mapa 2026</span></strong>
        <form class="search" id="search-form" role="search">
          <input id="search" type="search" placeholder="Buscar município ou UF" autocomplete="off" />
          <div id="search-results" class="search-results" hidden></div>
        </form>
        <p class="status" id="status"></p>
      </header>
      <section class="panel left" id="left-card">
        <div class="map-controls">
          <div class="segment" role="group" aria-label="Como ver o voto">
            <button type="button" data-action="vote" data-mode="municipios" aria-pressed="true">Municípios</button>
            <button type="button" data-action="vote" data-mode="vantagem">Vantagem</button>
            <button type="button" data-action="vote" data-mode="estados">Estados</button>
          </div>
          <label class="cross">Cruzar com
            <select id="indicator-select">
              <option value="">Só o voto</option>
              ${INDICATORS.map((item) => `<option value="${item.id}">${item.nome}</option>`).join("")}
            </select>
          </label>
        </div>
        <div id="left-panel"></div>
      </section>
      <aside class="panel right" id="right-panel"></aside>
      <div class="zoom">
        <button type="button" data-action="zoom" data-factor="in" aria-label="Aproximar">+</button>
        <button type="button" data-action="zoom" data-factor="out" aria-label="Afastar">−</button>
        <button type="button" data-action="reset" aria-label="Ver o Brasil">⌂</button>
      </div>
      <div class="legend" id="legend"></div>
      <div class="tooltip" id="tooltip" hidden></div>
    </main>`;
}

function toPath(polygons: Mun["g"]): Path2D {
  const path = new Path2D();
  for (const polygon of polygons) {
    for (const ring of polygon) {
      if (ring.length < 6) continue;
      path.moveTo(ring[0], ring[1]);
      for (let index = 2; index < ring.length; index += 2) path.lineTo(ring[index], ring[index + 1]);
      path.closePath();
    }
  }
  return path;
}

function toDrawable(mun: Mun): Drawable {
  const path = toPath(mun.g);
  let box: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const polygon of mun.g) {
    for (const ring of polygon) {
      if (ring.length < 6) continue;
      const next = ringBBox(ring);
      box = {
        minX: Math.min(box.minX, next.minX),
        minY: Math.min(box.minY, next.minY),
        maxX: Math.max(box.maxX, next.maxX),
        maxY: Math.max(box.maxY, next.maxY),
      };
    }
  }
  return {
    mun,
    path,
    box,
    leader: leaderOf(mun.fv, mun.lv),
    margem: mun.fp - mun.lp,
    fills: {
      municipios: "#2a2e36",
      vantagem: "#2a2e36",
      estados: "#2a2e36",
    },
  };
}

function hit(grid: SpatialGrid<Drawable>, x: number, y: number): Drawable | null {
  let found: Drawable | null = null;
  let area = Infinity;
  for (const item of querySpatialGrid(grid, x, y)) {
    if (!contains(item.box, x, y)) continue;
    const boxArea = (item.box.maxX - item.box.minX) * (item.box.maxY - item.box.minY);
    if (boxArea >= area) continue;
    if (!inside(item.mun, x, y)) continue;
    found = item;
    area = boxArea;
  }
  return found;
}

function inside(mun: Mun, x: number, y: number): boolean {
  return mun.g.some((polygon) => polygon[0] && pointInRing(x, y, polygon[0]) && !polygon.slice(1).some((ring) => pointInRing(x, y, ring)));
}

interface UfAgg {
  readonly sigla: string;
  fv: number;
  lv: number;
  vv: number;
  fp: number;
  lp: number;
  margem: number;
  leader: Leader;
  x: number;
  y: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function aggregate(drawables: readonly Drawable[]): Map<string, UfAgg> {
  const grouped = new Map<string, UfAgg>();
  for (const item of drawables) {
    const current = grouped.get(item.mun.uf) ?? {
      sigla: item.mun.uf, fv: 0, lv: 0, vv: 0, fp: 0, lp: 0, margem: 0, leader: "empate" as Leader,
      x: 0, y: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    };
    current.minX = Math.min(current.minX, item.box.minX);
    current.minY = Math.min(current.minY, item.box.minY);
    current.maxX = Math.max(current.maxX, item.box.maxX);
    current.maxY = Math.max(current.maxY, item.box.maxY);
    current.fv += item.mun.fv;
    current.lv += item.mun.lv;
    current.vv += item.mun.vv;
    current.x += ((item.box.minX + item.box.maxX) / 2) * item.mun.vv;
    current.y += ((item.box.minY + item.box.maxY) / 2) * item.mun.vv;
    grouped.set(item.mun.uf, current);
  }
  for (const uf of grouped.values()) {
    uf.fp = uf.vv ? (100 * uf.fv) / uf.vv : 0;
    uf.lp = uf.vv ? (100 * uf.lv) / uf.vv : 0;
    uf.margem = uf.fp - uf.lp;
    uf.leader = leaderOf(uf.fv, uf.lv);
    uf.x = uf.vv ? uf.x / uf.vv : uf.x;
    uf.y = uf.vv ? uf.y / uf.vv : uf.y;
  }
  return grouped;
}

function search(drawables: readonly Drawable[], query: string): Drawable[] {
  const needle = normalize(query);
  if (needle.length < 2) return [];
  return drawables.filter((item) => normalize(`${item.mun.nome} ${item.mun.uf}`).includes(needle)).slice(0, 8);
}

function focusOn(box: BBox, stage: HTMLElement, view: { scale: number; panX: number; panY: number }): void {
  const width = Math.max(1, box.maxX - box.minX);
  const height = Math.max(1, box.maxY - box.minY);
  const scale = Math.min(8, Math.min((stage.clientWidth * 0.45) / width, (stage.clientHeight * 0.45) / height));
  view.scale = scale;
  view.panX = stage.clientWidth / 2 - ((box.minX + box.maxX) / 2) * scale;
  view.panY = stage.clientHeight / 2 - ((box.minY + box.maxY) / 2) * scale;
}

function moveTooltip(x: number, y: number, item: Drawable | null): void {
  const tooltip = required("#tooltip");
  if (!item) {
    tooltip.hidden = true;
    return;
  }
  tooltip.hidden = false;
  tooltip.innerHTML = `<b>${escapeHtml(item.mun.nome)}</b>${item.mun.uf} · ${leaderLabel(item.leader)} ${formatNumber(Math.max(item.mun.fp, item.mun.lp), 1)}%`;
  tooltip.style.left = `${x + 14}px`;
  tooltip.style.top = `${y + 14}px`;
}

function toWorld(x: number, y: number, view: { scale: number; panX: number; panY: number }): { x: number; y: number } {
  return { x: (x - view.panX) / view.scale, y: (y - view.panY) / view.scale };
}

function indicatorValue(mun: Mun, id: IndicatorId): number | null {
  if (id === "abstencao") return mun.ab;
  const value = mun[id];
  return typeof value === "number" ? value : null;
}

function isIndicator(mode: Mode): mode is IndicatorId {
  return INDICATORS.some((item) => item.id === mode);
}

function extent(drawables: readonly Drawable[], id: IndicatorId): [number, number] {
  const values = drawables.map((item) => indicatorValue(item.mun, id)).filter((value): value is number => value !== null);
  if (values.length === 0) return [0, 1];
  return [Math.min(...values), Math.max(...values)];
}

function indicatorMode(mode: Mode): boolean {
  return isIndicator(mode);
}

function indicatorRow(indicator: (typeof INDICATORS)[number], value: number | null, uf: number | undefined): string {
  if (value === null) return "";
  const scale = Math.max(value, uf ?? value, 1);
  const comparison = uf === undefined ? "" : ` · UF ${formatIndicator(indicator.id, uf)}`;
  return `<div><span>${indicator.nome}</span><span class="track"><i style="width:${(value / scale) * 100}%"></i></span><span>${formatIndicator(indicator.id, value)}${comparison}</span></div>`;
}

function formatIndicator(id: string, value: number): string {
  const unit = INDICATORS.find((item) => item.id === id)?.unidade;
  if (unit === "R$") return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  if (unit === "hab/km²") return `${formatNumber(value, value >= 100 ? 0 : 1)} hab/km²`;
  return `${formatNumber(value, 1)}%`;
}

function leaderLabel(leader: Leader): string {
  if (leader === "flavio") return "Flávio";
  if (leader === "lula") return "Lula";
  return "Empate";
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
}

function required(selector: string): HTMLElement {
  const node = document.querySelector(selector);
  if (!(node instanceof HTMLElement)) throw new Error(`missing ${selector}`);
  return node;
}

function requiredCanvas(selector: string): HTMLCanvasElement {
  const node = document.querySelector(selector);
  if (!(node instanceof HTMLCanvasElement)) throw new Error(`missing ${selector}`);
  return node;
}

function requiredInput(selector: string): HTMLInputElement {
  const node = document.querySelector(selector);
  if (!(node instanceof HTMLInputElement)) throw new Error(`missing ${selector}`);
  return node;
}

function requiredSelect(selector: string): HTMLSelectElement {
  const node = document.querySelector(selector);
  if (!(node instanceof HTMLSelectElement)) throw new Error(`missing ${selector}`);
  return node;
}
