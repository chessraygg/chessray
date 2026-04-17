/**
 * Recursive split-pane layout engine.
 *
 * The layout is a tree of split and leaf nodes. Splits are row/col containers
 * with relative sizes; leaves are individual sections whose DOM body is moved
 * into the layout at render time.
 *
 * Drag a leaf's header onto another leaf's edge zone to reparent: drop on
 * top/bottom splits column-wise, left/right splits row-wise. Removing a leaf
 * automatically collapses its split (single-child splits flatten into parent),
 * so gaps are impossible — space "pulls up and left" by construction.
 */

export type LayoutNode =
  | { type: 'leaf'; id: string }
  | { type: 'split'; dir: 'row' | 'col'; children: LayoutNode[]; sizes: number[] };

export interface SectionDef {
  id: string;
  title: string;
  /** The section's pre-existing body DOM element. Moved into the active leaf on each render. */
  body: HTMLElement;
}

export interface SplitLayoutState {
  layout: LayoutNode | null;
  hiddenIds: string[];
}

export interface SplitLayoutOptions {
  initialLayout?: LayoutNode | null;
  hiddenIds?: string[];
  onChange?: (state: SplitLayoutState) => void;
}

const MIN_FRACTION = 0.05;
type DropZone = 'n' | 's' | 'e' | 'w' | 'center';

export class SplitLayout {
  private root: HTMLElement;
  private sections: Map<string, SectionDef>;
  private layout: LayoutNode | null = null;
  private hiddenIds: Set<string>;
  private onChange?: (state: SplitLayoutState) => void;
  private tray: HTMLDivElement;

  constructor(root: HTMLElement, sections: SectionDef[], opts: SplitLayoutOptions = {}) {
    this.root = root;
    this.sections = new Map(sections.map(s => [s.id, s]));
    this.hiddenIds = new Set(opts.hiddenIds ?? []);

    let initial: LayoutNode | null = isValidLayout(opts.initialLayout)
      ? opts.initialLayout
      : this.defaultLayout(sections.map(s => s.id));
    for (const id of this.hiddenIds) {
      initial = removeLeaf(initial, id);
    }
    this.layout = initial;
    this.onChange = opts.onChange;

    this.tray = document.createElement('div');
    this.tray.className = 'hidden-tray';
    this.root.parentElement?.insertBefore(this.tray, this.root.nextSibling);

    this.render();
  }

  hide(id: string): void {
    if (this.hiddenIds.has(id)) return;
    this.hiddenIds.add(id);
    this.layout = removeLeaf(this.layout, id);
    this.render();
    this.notify();
  }

  show(id: string): void {
    if (!this.hiddenIds.has(id)) return;
    this.hiddenIds.delete(id);
    if (!this.layout) {
      this.layout = { type: 'leaf', id };
    } else if (this.layout.type === 'split' && this.layout.dir === 'col') {
      const total = this.layout.sizes.reduce((a, b) => a + b, 0);
      const newShare = total / (this.layout.sizes.length + 1);
      const scale = (total - newShare) / total;
      this.layout = {
        ...this.layout,
        children: [...this.layout.children, { type: 'leaf', id }],
        sizes: [...this.layout.sizes.map(s => s * scale), newShare],
      };
    } else {
      this.layout = {
        type: 'split', dir: 'col',
        children: [this.layout, { type: 'leaf', id }],
        sizes: [0.75, 0.25],
      };
    }
    this.render();
    this.notify();
  }

  getState(): SplitLayoutState {
    return { layout: this.layout, hiddenIds: [...this.hiddenIds] };
  }

  private notify(): void {
    this.onChange?.(this.getState());
  }

  private defaultLayout(ids: string[]): LayoutNode {
    if (ids.length === 1) return { type: 'leaf', id: ids[0] };
    return {
      type: 'split', dir: 'col',
      sizes: ids.map(() => 1 / ids.length),
      children: ids.map(id => ({ type: 'leaf' as const, id })),
    };
  }

  private render(): void {
    this.root.innerHTML = '';
    if (this.layout) {
      this.root.appendChild(this.buildNode(this.layout));
    }
    this.renderTray();
  }

  private buildNode(node: LayoutNode): HTMLElement {
    return node.type === 'leaf' ? this.buildLeaf(node) : this.buildSplit(node);
  }

  private buildSplit(node: Extract<LayoutNode, { type: 'split' }>): HTMLElement {
    const el = document.createElement('div');
    el.className = `split ${node.dir}`;
    node.children.forEach((child, i) => {
      const childEl = this.buildNode(child);
      childEl.style.flex = `${node.sizes[i]} 1 0`;
      el.appendChild(childEl);
      if (i < node.children.length - 1) {
        el.appendChild(this.makeSplitter(node, i));
      }
    });
    return el;
  }

  private buildLeaf(node: Extract<LayoutNode, { type: 'leaf' }>): HTMLElement {
    const sec = this.sections.get(node.id);
    const el = document.createElement('div');
    el.className = 'leaf';
    el.dataset.leafId = node.id;

    if (!sec) {
      el.textContent = `[missing: ${node.id}]`;
      return el;
    }

    const header = document.createElement('div');
    header.className = 'section-header';
    header.dataset.section = node.id;
    header.innerHTML = `<span class="title">${sec.title}</span>`;
    const hide = document.createElement('button');
    hide.className = 'hide-btn';
    hide.title = 'Hide section';
    hide.textContent = '×';
    header.appendChild(hide);
    el.appendChild(header);

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'leaf-body';
    bodyWrap.appendChild(sec.body);
    el.appendChild(bodyWrap);

    const overlay = document.createElement('div');
    overlay.className = 'drop-overlay';
    overlay.innerHTML = `
      <div class="drop-zone zone-n" data-zone="n"></div>
      <div class="drop-zone zone-e" data-zone="e"></div>
      <div class="drop-zone zone-s" data-zone="s"></div>
      <div class="drop-zone zone-w" data-zone="w"></div>
      <div class="drop-zone zone-center" data-zone="center"></div>
    `;
    el.appendChild(overlay);

    hide.addEventListener('mousedown', (e) => e.stopPropagation());
    hide.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hide(node.id);
    });
    header.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.hide-btn')) return;
      this.startDrag(e, node.id, el);
    });
    return el;
  }

  private makeSplitter(parent: Extract<LayoutNode, { type: 'split' }>, index: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'splitter';
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      el.classList.add('dragging');
      const parentEl = el.parentElement!;
      const rect = parentEl.getBoundingClientRect();
      const isRow = parent.dir === 'row';
      const totalSize = isRow ? rect.width : rect.height;
      const startSizes = [...parent.sizes];
      const startPos = isRow ? e.clientX : e.clientY;

      const onMove = (ev: MouseEvent) => {
        const cur = isRow ? ev.clientX : ev.clientY;
        const deltaFrac = (cur - startPos) / (totalSize || 1);
        const a = startSizes[index] + deltaFrac;
        const b = startSizes[index + 1] - deltaFrac;
        if (a < MIN_FRACTION || b < MIN_FRACTION) return;
        parent.sizes[index] = a;
        parent.sizes[index + 1] = b;
        const children = [...parentEl.children].filter(c => !c.classList.contains('splitter')) as HTMLElement[];
        if (children[index]) children[index].style.flex = `${a} 1 0`;
        if (children[index + 1]) children[index + 1].style.flex = `${b} 1 0`;
      };
      const onUp = (): void => {
        el.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        this.notify();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    return el;
  }

  private startDrag(e: MouseEvent, leafId: string, leafEl: HTMLElement): void {
    e.preventDefault();
    const sec = this.sections.get(leafId);
    if (!sec) return;
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = sec.title;
    document.body.appendChild(ghost);
    leafEl.classList.add('dragging');

    let hoverZoneEl: HTMLElement | null = null;
    let hoverZone: DropZone | null = null;

    const setGhost = (ev: MouseEvent): void => {
      ghost.style.left = `${ev.clientX + 12}px`;
      ghost.style.top = `${ev.clientY + 12}px`;
    };
    setGhost(e);

    this.root.querySelectorAll<HTMLElement>('.leaf').forEach(l => {
      if (l.dataset.leafId !== leafId) l.classList.add('drop-active');
    });

    const onMove = (ev: MouseEvent): void => {
      setGhost(ev);
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const zoneEl = (el as HTMLElement | null)?.closest<HTMLElement>('.drop-zone') ?? null;
      if (hoverZoneEl) hoverZoneEl.classList.remove('hover');
      if (zoneEl) {
        zoneEl.classList.add('hover');
        hoverZoneEl = zoneEl;
        hoverZone = (zoneEl.dataset.zone as DropZone) ?? null;
      } else {
        hoverZoneEl = null;
        hoverZone = null;
      }
    };

    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      this.root.querySelectorAll('.leaf').forEach(l => l.classList.remove('drop-active'));
      this.root.querySelectorAll('.drop-zone').forEach(z => z.classList.remove('hover'));
      ghost.remove();
      leafEl.classList.remove('dragging');

      if (hoverZoneEl && hoverZone) {
        const targetEl = hoverZoneEl.closest<HTMLElement>('.leaf');
        const targetId = targetEl?.dataset.leafId;
        if (targetId && targetId !== leafId) {
          this.performDrop(leafId, targetId, hoverZone);
        }
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  private performDrop(srcId: string, targetId: string, zone: DropZone): void {
    const withoutSrc = removeLeaf(this.layout, srcId);
    this.layout = insertAt(withoutSrc, targetId, srcId, zone, this.hiddenIds);
    this.render();
    this.notify();
  }

  private renderTray(): void {
    this.tray.innerHTML = '';
    for (const id of this.hiddenIds) {
      const sec = this.sections.get(id);
      if (!sec) continue;
      const btn = document.createElement('button');
      btn.textContent = `+ ${sec.title}`;
      btn.onclick = () => this.show(id);
      this.tray.appendChild(btn);
    }
  }
}

/** Shallow structural check: reject legacy/malformed layouts so we fall back to defaults. */
function isValidLayout(node: unknown): node is LayoutNode {
  if (!node || typeof node !== 'object') return false;
  const n = node as Partial<LayoutNode>;
  if (n.type === 'leaf') return typeof (n as { id?: unknown }).id === 'string';
  if (n.type === 'split') {
    const s = n as Extract<LayoutNode, { type: 'split' }>;
    return (s.dir === 'row' || s.dir === 'col')
      && Array.isArray(s.children) && s.children.length > 0
      && Array.isArray(s.sizes) && s.sizes.length === s.children.length
      && s.children.every(isValidLayout);
  }
  return false;
}

/** Remove a leaf from the tree, flattening single-child splits. */
function removeLeaf(node: LayoutNode | null, id: string): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'leaf') return node.id === id ? null : node;
  const kids: LayoutNode[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const c = removeLeaf(node.children[i], id);
    if (c) { kids.push(c); sizes.push(node.sizes[i]); }
  }
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { type: 'split', dir: node.dir, children: kids, sizes: sizes.map(s => s / total) };
}

/** Insert `newId` next to `targetId` in the given zone. */
function insertAt(node: LayoutNode | null, targetId: string, newId: string, zone: DropZone, hiddenIds: Set<string>): LayoutNode {
  if (!node) return { type: 'leaf', id: newId };
  if (node.type === 'leaf') {
    if (node.id !== targetId) return node;
    if (zone === 'center') {
      hiddenIds.add(targetId);
      return { type: 'leaf', id: newId };
    }
    const dir: 'row' | 'col' = (zone === 'n' || zone === 's') ? 'col' : 'row';
    const newLeaf: LayoutNode = { type: 'leaf', id: newId };
    const targetLeaf: LayoutNode = { type: 'leaf', id: targetId };
    const before = (zone === 'n' || zone === 'w');
    return {
      type: 'split', dir,
      children: before ? [newLeaf, targetLeaf] : [targetLeaf, newLeaf],
      sizes: [0.5, 0.5],
    };
  }
  return {
    ...node,
    children: node.children.map(c => insertAt(c, targetId, newId, zone, hiddenIds)),
  };
}
