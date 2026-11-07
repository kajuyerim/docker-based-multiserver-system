import { Application, Container, Graphics } from 'pixi.js';
import type { BackendSnapshot, SemanticEvent, Snapshot } from '../model/types';
import { overlaps, placeLabel } from './layout';
import type { Rect } from './layout';
import { SceneLayout } from '../ui/scene-layout';
import { Viewport } from './viewport';
import type { ViewportState } from './viewport';
import { MapNavigation } from '../ui/map-navigation';

export type ComponentId = 'clients' | 'nginx' | 'redis' | `app${number}`;
type Point = { x: number; y: number };
const colors = { ink: 0x253744, green: 0x287f83, blue: 0x7763a3,
  amber: 0xb88029, red: 0xa64a42, idle: 0x738b96 };

export function backendState(b: BackendSnapshot): string {
  if (b.state !== 'running') return b.state === 'stopped' ? 'Stopped' : b.state === 'starting' ? 'Starting' : 'Draining';
  if (b.inFlight >= b.inFlightLimit || b.cpuQueue > 5) return 'Saturated';
  return b.inFlight ? 'Busy' : 'Idle';
}

interface Building { container: Container; shape: Graphics; label: HTMLButtonElement; status: string; point: Point; color: number }

export class Campus {
  private app = new Application();
  private world = new Container();
  private roads = new Graphics();
  private leaders = new Graphics();
  private buildings = new Map<ComponentId, Building>();
  private markers: Graphics[] = [];
  private selection = new Graphics();
  private snapshot?: Snapshot;
  private ready = false;
  private reduced = false;
  private topology = '';
  private layout?: SceneLayout;
  private host?: HTMLElement;
  private area: Rect = { x: 0, y: 0, width: 1, height: 1 };
  private selected: ComponentId = 'nginx';
  private view = new Viewport();
  private navigation?: MapNavigation;

  async mount(host: HTMLElement, onSelect: (id: ComponentId) => void, onRequest: (id: number) => void): Promise<void> {
    this.host = host;
    await this.app.init({ backgroundAlpha: 0, antialias: true, resolution: Math.min(devicePixelRatio, 2), autoDensity: true,
      autoStart: false, preference: 'webgl', width: host.clientWidth, height: host.clientHeight });
    host.append(this.app.canvas);
    this.app.canvas.setAttribute('aria-hidden', 'true');
    this.world.sortableChildren = true;
    this.app.stage.addChild(this.world, this.leaders);
    const ground = new Graphics();
    ground.poly([-350, 270, 620, -210, 1570, 270, 590, 770]).fill(0xaebdc2);
    for (let x = -800; x < 1900; x += 55) {
      ground.moveTo(x, -300).lineTo(x + 1500, 800).stroke({ width: 1, color: 0xc4cfd2, alpha: 0.25 });
      ground.moveTo(x, 800).lineTo(x + 1500, -300).stroke({ width: 1, color: 0xc4cfd2, alpha: 0.25 });
    }
    ground.poly([-10, 338, 627, 13, 1172, 291, 1172, 312, 545, 636, -10, 356]).fill(0x526e7a);
    ground.poly([-10, 338, 627, 13, 1172, 291, 545, 615]).fill(0x8ea2a8).stroke({ width: 2, color: 0xe1e7e3 });
    ground.poly([20, 337, 627, 28, 1140, 291, 545, 599]).stroke({ width: 1, color: 0xb7c8cb, alpha: 0.6 });
    this.world.addChild(ground, this.roads, this.selection);
    const add = (id: ComponentId, label: string, point: Point) => {
      const container = new Container();
      container.zIndex = 2;
      container.position.set(point.x, point.y);
      const shape = new Graphics();
      const caption = document.createElement('button');
      caption.className = 'component-label';
      caption.dataset.sceneComponent = id;
      caption.innerHTML = `<strong>${label}</strong><span></span>`;
      caption.addEventListener('click', event => { if (!event.detail || this.navigation?.canSelect(event)) onSelect(id); });
      host.append(caption);
      container.addChild(shape);
      container.eventMode = 'static'; container.cursor = 'pointer';
      container.on('pointertap', event => { if (this.navigation?.canSelect(event.nativeEvent as PointerEvent)) onSelect(id); });
      this.world.addChild(container);
      this.buildings.set(id, { container, shape, label: caption, status: '', point, color: -1 });
    };
    this.add = add;
    add('clients', 'Clients', { x: 120, y: 330 });
    add('nginx', 'NGINX', { x: 330, y: 300 });
    add('redis', 'Redis', { x: 1030, y: 300 });
    for (let i = 0; i < 200; i++) {
      const marker = new Graphics().circle(0, 0, 4).fill(0xffffff).stroke({ width: 2, color: colors.green });
      marker.zIndex = 1;
      marker.visible = false; marker.eventMode = 'static'; marker.cursor = 'pointer';
      marker.on('pointertap', event => {
        if (marker.label && this.navigation?.canSelect(event.nativeEvent as PointerEvent)) onRequest(Number(marker.label));
      });
      this.markers.push(marker); this.world.addChild(marker);
    }
    this.navigation = new MapNavigation(host, document.getElementById('map-navigation')!, this.view, {
      changed: () => this.applyViewport(), focusTarget: () => this.componentBounds(this.selected), reduced: () => this.reduced,
    });
    await new Promise<void>(resolve => {
      this.layout = new SceneLayout(host, area => {
        this.area = area;
        this.app.renderer.resize(host.clientWidth, host.clientHeight);
        this.reframe();
        resolve();
      });
    });
    this.ready = true;
  }

  private add: (id: ComponentId, label: string, point: Point) => void = () => {};

  update(snapshot: Snapshot, selected: ComponentId, reduced: boolean): void {
    if (!this.ready) return;
    this.snapshot = snapshot; this.reduced = reduced; this.selected = selected;
    const topology = snapshot.backends.map(b => b.id).join(',');
    if (topology !== this.topology) {
      this.topology = topology;
      for (const [id, b] of this.buildings) if (id.startsWith('app')) { b.container.destroy({ children: true }); b.label.remove(); this.buildings.delete(id); }
      const count = snapshot.backends.length;
      snapshot.backends.forEach((b, i) => {
        const columns = count > 4 ? 2 : 1;
        const rows = Math.ceil(count / columns);
        const column = Math.floor(i / rows), row = i % rows;
        this.add(`app${b.id}`, `app${b.id}`, { x: columns === 1 ? 660 : 590 + column * 190, y: 315 + (row - (rows - 1) / 2) * (rows < 4 ? 190 : 150) });
      });
      this.roads.clear();
      const path = (from: Point, to: Point) => {
        this.roads.moveTo(from.x, from.y + 12).lineTo(to.x, to.y + 12).stroke({ width: 17, color: 0xbac8c8 });
        this.roads.moveTo(from.x, from.y + 12).lineTo(to.x, to.y + 12).stroke({ width: 12, color: 0x3e5965 });
        this.roads.moveTo(from.x, from.y + 12).lineTo(to.x, to.y + 12).stroke({ width: 1, color: 0x7fa0ad });
      };
      path(this.point('clients'), this.point('nginx'));
      for (const b of snapshot.backends) { path(this.point('nginx'), this.point(`app${b.id}`)); path(this.point(`app${b.id}`), this.point('redis')); }
      for (const marker of this.markers) this.world.addChild(marker);
      this.reframe();
    }
    this.paint('clients', colors.blue, `${snapshot.config.rate} offered /s`);
    this.paint('nginx', colors.green, snapshot.config.retry ? 'Retries enabled' : 'Retries disabled');
    this.paint('redis', !snapshot.redis.online ? colors.red : snapshot.redis.queue > 5 ? colors.amber : colors.green,
      `${snapshot.redis.online ? 'Online' : 'Offline'} · ${snapshot.redis.queue} queued`);
    for (const b of snapshot.backends) {
      const state = backendState(b);
      const color = state === 'Stopped' ? colors.red : state === 'Saturated' ? colors.amber : state === 'Draining' || state === 'Starting' ? colors.blue : state === 'Idle' ? colors.idle : colors.green;
      this.paint(`app${b.id}`, color, `${state} · ${b.inFlight} in flight`);
    }
    const point = this.point(selected);
    this.selection.clear().ellipse(point.x, point.y + 12, 78, 43).stroke({ color: 0xe5f3ec, width: 2, alpha: 0.9 });
    this.labels();
  }

  render(displayTime = this.snapshot?.now ?? 0): void {
    const snapshot = this.snapshot;
    if (!snapshot || !this.ready) return;
    const events = snapshot.events.filter(e => e.request !== undefined && displayTime - e.at >= 0 && displayTime - e.at < 400_000 && this.segment(e));
    const selected = events.slice(-200);
    this.markers.forEach((marker, index) => {
      const event = selected[index];
      marker.visible = !this.reduced && event !== undefined;
      if (!event || this.reduced) return;
      const [from, to] = this.segment(event)!;
      const progress = Math.min(1, (displayTime - event.at) / 400_000);
      marker.position.set(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress + 12);
      marker.tint = event.kind === 'attempt-failed' || (event.kind === 'terminal' && !event.message.endsWith('success')) ? colors.red : event.kind === 'retry' ? colors.amber : 0xffffff;
      marker.alpha = 1 - progress * 0.6;
      marker.label = String(event.request);
    });
    this.app.render();
  }

  destroy(): void {
    this.navigation?.destroy();
    this.layout?.destroy();
    for (const b of this.buildings.values()) b.label.remove();
    this.app.destroy(true, { children: true });
  }

  saveView(): ViewportState { return this.view.save(); }
  restoreView(state: ViewportState): void { this.navigation?.cancel(); this.view.restore(state); this.applyViewport(); }
  fitMap(): void { this.navigation?.fit(); }

  private componentBounds(id: ComponentId): Rect {
    const p = this.point(id);
    return { x: p.x - 85, y: p.y - 85, width: 170, height: 140 };
  }

  private reframe(): void {
    this.navigation?.cancel();
    const points = [...this.buildings.values()].map(b => b.point);
    if (!points.length) return;
    const x = Math.min(...points.map(p => p.x)) - 90, y = Math.min(...points.map(p => p.y)) - 100;
    const bounds = { x, y, width: Math.max(...points.map(p => p.x)) + 125 - x,
      height: Math.max(...points.map(p => p.y)) + 90 - y };
    this.view.context(bounds, this.area, [...this.buildings.keys()].map(id => this.componentBounds(id)));
    this.applyViewport();
  }

  private applyViewport(): void {
    const transform = this.view.transform;
    this.world.scale.set(transform.scale);
    this.world.position.set(transform.x, transform.y);
    this.labels();
    const zoom = document.getElementById('map-zoom');
    if (zoom) zoom.textContent = `${Math.round(this.view.zoom * 100)}%`;
    this.render();
  }

  private labels(): void {
    const area = this.area;
    const needsAttention = (b: Building) => [colors.red, colors.amber].includes(b.color) || b.status.startsWith('Draining');
    const ordered = [...this.buildings.entries()].sort(([a, x], [b, y]) =>
      Number(b === this.selected) - Number(a === this.selected) ||
      Number(needsAttention(y)) - Number(needsAttention(x)));
    this.leaders.clear();
    const selectedPoint = this.point(this.selected), scale = this.world.scale.x;
    const occupied: Rect[] = [{ x: this.world.x + (selectedPoint.x - 85) * scale,
      y: this.world.y + (selectedPoint.y - 85) * scale, width: 170 * scale, height: 140 * scale }];
    let used = 0, collapsed = 0;
    for (const [id, building] of ordered) {
      const isSelected = id === this.selected;
      const attention = needsAttention(building);
      const label = building.label;
      label.hidden = false;
      label.setAttribute('aria-pressed', String(isSelected));
      label.classList.toggle('detailed', isSelected || attention);
      label.querySelector('span')!.textContent = building.status;
      label.setAttribute('aria-label', `${id === 'clients' ? 'Clients' : id === 'nginx' ? 'NGINX' : id === 'redis' ? 'Redis' : id}: ${building.status}. Inspect component`);
      const anchor = { x: this.world.x + (building.point.x - 85) * scale,
        y: this.world.y + (building.point.y - 85) * scale, width: 170 * scale, height: 140 * scale };
      if (!overlaps(anchor, area)) { label.hidden = true; collapsed++; continue; }
      const size = { width: label.offsetWidth, height: label.offsetHeight };
      const placement = placeLabel(anchor, size, area, occupied, isSelected || attention);
      const budget = area.width * area.height * 0.22;
      if (!placement || (!isSelected && !attention && used + size.width * size.height > budget)) {
        label.hidden = true; collapsed++; continue;
      }
      label.style.left = `${placement.x}px`; label.style.top = `${placement.y}px`;
      const center = { x: this.world.x + building.point.x * scale, y: this.world.y + (building.point.y - 35) * scale };
      const edge = { x: Math.max(placement.x, Math.min(placement.x + placement.width, center.x)),
        y: Math.max(placement.y, Math.min(placement.y + placement.height, center.y)) };
      if (Math.hypot(center.x - edge.x, center.y - edge.y) > 48) {
        this.leaders.moveTo(center.x, center.y).lineTo(edge.x, edge.y).stroke({ color: colors.ink, width: 1, alpha: .65 });
      }
      occupied.push(placement); used += size.width * size.height;
    }
    if (this.host) {
      this.host.style.setProperty('--scene-x', `${area.x}px`);
      this.host.style.setProperty('--scene-y', `${area.y}px`);
      this.host.style.setProperty('--scene-width', `${area.width}px`);
      this.host.style.setProperty('--scene-height', `${area.height}px`);
      const help = document.getElementById('label-help');
      if (help) help.textContent = collapsed ? `${collapsed} labels hidden. Inspect any component using the selector.` : 'Select a building or its label to inspect.';
    }
  }
  private point(id: ComponentId): Point { return this.buildings.get(id)?.point ?? { x: 660, y: 300 }; }
  private segment(e: SemanticEvent): [Point, Point] | undefined {
    const backend = this.point(`app${e.backend ?? 1}`);
    const proxy = this.point('nginx'), redis = this.point('redis'), clients = this.point('clients');
    switch (e.kind) {
      case 'arrival': return [clients, proxy];
      case 'routing': return [proxy, backend];
      case 'queue': case 'processing': case 'sleep': return [backend, { x: backend.x + 8, y: backend.y - 24 }];
      case 'redis-send': return [backend, redis];
      case 'redis-queue': case 'redis-execute': return [redis, { x: redis.x + 8, y: redis.y - 20 }];
      case 'redis-ack': return [redis, backend];
      case 'response': case 'attempt-failed': case 'retry': return [backend, proxy];
      case 'terminal': return [proxy, clients];
      default: return undefined;
    }
  }
  private paint(id: ComponentId, color: number, status: string): void {
    const b = this.buildings.get(id)!;
    b.status = status;
    b.label.style.borderLeftColor = `#${color.toString(16).padStart(6, '0')}`;
    if (b.color === color) return;
    b.color = color;
    const g = b.shape.clear();
    const box = (x: number, y: number, w: number, d: number, h: number, roof = 0xe0e6df, side = 0x435e6d) => {
      g.poly([x-w,y-h,x,y+d-h,x,y+d,x-w,y]).fill(side);
      g.poly([x,y+d-h,x+w,y-h,x+w,y,x,y+d]).fill(0x829ba3);
      g.poly([x-w,y-h,x,y-d-h,x+w,y-h,x,y+d-h]).fill(roof).stroke({ width: 1, color: 0xe0e7e5, alpha: .65 });
    };
    g.poly([-75,15,8,-28,121,43,37,89]).fill({ color: 0x284251, alpha: .25 });
    box(0, 13, 85, 43, 7, 0x9fb2b8, 0x6a818e);
    g.poly([-78,5,0,-35,78,5,0,45]).stroke({ width: 2, color, alpha: .9 });
    if (id.startsWith('app')) {
      for (const x of [-32, 0, 32]) {
        const y = x * .45 - 2;
        box(x, y, 16, 9, 62, 0xd7e2e1, 0x536e7e);
        for (let row = 0; row < 5; row++) {
          const sy = y - 53 + row * 10;
          g.poly([x-12,sy,x-3,sy+5,x-3,sy+8,x-12,sy+3]).fill(0xa8c0ca);
          g.circle(x-8,sy+3,1.5).fill(color);
        }
        g.poly([x-12,y-62,x,y-69,x+12,y-62,x,y-56]).fill(color);
      }
    } else if (id === 'redis') {
      for (const [x,y,h] of [[-23,2,69],[23,16,58]]) {
        g.rect(x!-20,y!-h!,40,h!).fill(0x708d9c);
        g.ellipse(x!,y!,20,10).fill(0x708d9c);
        for (let row = 0; row < 4; row++) g.ellipse(x!,y!-h!+row*15,20,10).stroke({ color: 0xb9ced3, width: 2 });
        g.ellipse(x!,y!-h!,20,10).fill(0xd9e4e2).stroke({ color: 0xe4ece8, width: 1 });
        g.ellipse(x!,y!-h!,11,5).fill(color);
      }
    } else if (id === 'nginx') {
      box(-38,0,15,10,58,0xdbe3e0,0x526c7c);
      box(38,0,15,10,58,0xdbe3e0,0x526c7c);
      box(0,-45,57,20,15,0xc8d8d9,0x506f7e);
      g.poly([-38,-53,0,-72,38,-53,0,-34]).fill(color);
      g.poly([-14,-52,-3,-58,-3,-52,15,-52,15,-45,-3,-45,-3,-39]).fill(0xe9f0ec);
      for (const x of [-18,0,18]) g.poly([x-3,10,x+8,4,x+8,10,x-3,16]).fill(0xafd1d5);
    } else {
      for (const [x,y] of [[-32,-8],[0,8],[32,24]]) {
        box(x!,y!,17,9,9,0xd2dfdf,0x6e8794);
        box(x!,y!-7,13,7,37,0xe0e8e3,0x78929f);
        g.poly([x!-10,y!-39,x!-1,y!-34,x!-1,y!-17,x!-10,y!-22]).fill(0x4e788c);
        g.poly([x!+2,y!-34,x!+10,y!-39,x!+10,y!-22,x!+2,y!-17]).fill(color);
      }
    }
  }
}
