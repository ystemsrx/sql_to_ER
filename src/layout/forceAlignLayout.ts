/**
 * Force Align Layout Module
 * - Main chain (longest entity/rel path) placed horizontally
 * - Off-main branches laid out as real subtrees with leaf-count-proportional
 *   angular sectors; single-child chains extend colinearly, multi-child nodes
 *   fan out in a forward semicircle. No post-hoc "fix-up" passes fight each
 *   other.
 */

import { animateNodesToTargets, smoothFitView } from "./animation";
import { deterministicHash, normalizeAngle } from "./utils";

    export const forceAlignLayout = (graph, containerWidth) => {
        if (!graph || graph.destroyed) return;
        const allNodes = graph.getNodes();
        if (!allNodes.length) return;

        const isCore = (type) => type === 'entity' || type === 'relationship';

        const nodeMap = new Map();
        const coreNodes = [];
        const attributeNodes = [];
        allNodes.forEach(n => {
            const m = n.getModel();
            nodeMap.set(m.id, n);
            if (isCore(m.nodeType)) coreNodes.push(n);
            else if (m.nodeType === 'attribute') attributeNodes.push(n);
        });
        if (!coreNodes.length) return;

        const typeOf = (id) => nodeMap.get(id)?.getModel().nodeType;
        const isEnt = (id) => typeOf(id) === 'entity';
        const isRel = (id) => typeOf(id) === 'relationship';

        // 属性归属
        const entityAttrs = new Map();
        attributeNodes.forEach(attr => {
            const pid = attr.getModel().parentEntity;
            if (!pid) return;
            if (!entityAttrs.has(pid)) entityAttrs.set(pid, []);
            entityAttrs.get(pid).push(attr);
        });

        const getRadius = (node) => {
            const b = node.getBBox();
            return Math.sqrt(b.width * b.width + b.height * b.height) / 2;
        };

        // 核心邻接（矩形↔菱形）
        const coreAdj = new Map();
        graph.getEdges().forEach(edge => {
            const { source, target } = edge.getModel();
            if (!isCore(typeOf(source)) || !isCore(typeOf(target))) return;
            if (!coreAdj.has(source)) coreAdj.set(source, new Set());
            if (!coreAdj.has(target)) coreAdj.set(target, new Set());
            coreAdj.get(source).add(target);
            coreAdj.get(target).add(source);
        });
        if (!coreAdj.size) return;

        // 连通分量
        const visited = new Set();
        const components = [];
        coreNodes.forEach(n => {
            const id = n.getModel().id;
            if (visited.has(id)) return;
            const stack = [id];
            const comp = [];
            visited.add(id);
            while (stack.length) {
                const cur = stack.pop();
                comp.push(cur);
                (coreAdj.get(cur) || []).forEach(nb => {
                    if (!visited.has(nb)) {
                        visited.add(nb);
                        stack.push(nb);
                    }
                });
            }
            components.push(comp);
        });

        const bfsFarthest = (start, allowed) => {
            const dist = new Map();
            const prev = new Map();
            const queue = [start];
            dist.set(start, 0);
            while (queue.length) {
                const cur = queue.shift();
                (coreAdj.get(cur) || []).forEach(nb => {
                    if (!allowed.has(nb) || dist.has(nb)) return;
                    dist.set(nb, dist.get(cur) + 1);
                    prev.set(nb, cur);
                    queue.push(nb);
                });
            }
            let farthest = start;
            dist.forEach((d, id) => { if (d > dist.get(farthest)) farthest = id; });
            return { farthest, prev };
        };

        const findLongestPath = (ids) => {
            const allowed = new Set(ids);
            const { farthest: endA } = bfsFarthest(ids[0], allowed);
            const { farthest: endB, prev } = bfsFarthest(endA, allowed);
            const path = [];
            let cur = endB;
            while (cur !== undefined) {
                path.unshift(cur);
                cur = prev.get(cur);
            }
            return path.length ? path : [ids[0]];
        };

        // ------- 主链每个分量的布局 -------
        const layoutComponent = (ids) => {
            const targets = new Map();
            const radii = new Map();
            ids.forEach(id => radii.set(id, getRadius(nodeMap.get(id))));
            const maxR = Math.max(...radii.values());
            const GAP = 48;
            const chainSpacing = Math.max(200, maxR * 2 + GAP);

            const mainPath = findLongestPath(ids);
            const mainPathSet = new Set(mainPath);

            const startX = -((mainPath.length - 1) * chainSpacing) / 2;
            mainPath.forEach((id, idx) => {
                targets.set(id, { x: startX + idx * chainSpacing, y: 0 });
            });

            // placed 追踪已放置的核心节点（含主链）
            const placed = new Set(mainPath);

            // 构造"从某个已放置节点出发、向外扩展的子树"
            // 返回 { id, type, children: [...] }，child 的根类型一定和当前节点交替
            const buildRelSubtree = (relId, parentEntityId) => {
                placed.add(relId);
                const node = { id: relId, type: 'rel', children: [] };
                const ents = Array.from(coreAdj.get(relId) || [])
                    .filter(id => isEnt(id) && id !== parentEntityId && !placed.has(id))
                    .sort(); // 稳定顺序
                ents.forEach(eid => {
                    placed.add(eid);
                    node.children.push(buildEntityNode(eid));
                });
                return node;
            };

            const buildEntityNode = (entityId) => {
                const node = { id: entityId, type: 'entity', children: [] };
                const rels = Array.from(coreAdj.get(entityId) || [])
                    .filter(id => isRel(id) && !placed.has(id))
                    .sort();
                rels.forEach(rid => {
                    // 只在有未放置实体邻居时加入为树子节点；否则交给"弦"阶段处理
                    const relEnts = Array.from(coreAdj.get(rid) || []).filter(isEnt);
                    const hasUnplacedEnt = relEnts.some(e => e !== entityId && !placed.has(e));
                    const isUnary = relEnts.length === 1; // 自关联等
                    if (hasUnplacedEnt || isUnary) {
                        node.children.push(buildRelSubtree(rid, entityId));
                    }
                });
                return node;
            };

            const countLeaves = (node) => {
                if (!node.children.length) return 1;
                return node.children.reduce((s, c) => s + countLeaves(c), 0);
            };

            // 子树"宽度"估算：每片叶子需要约 (2*maxR + GAP) 的横向空间
            const unitWidth = maxR * 1.6 + GAP;
            const approxWidth = (n) => Math.max(1, countLeaves(n)) * unitWidth;

            // 递归放置：node 自身放在以 parentPos 为圆心、angle 方向上，
            // 距离至少为 minDist（由父节点按子树宽度反算），否则用默认近距。
            // sectorSize 是留给 node 及其子孙横向展开的角度上限。
            const placeNode = (node, parentPos, parentR, angle, sectorSize, minDist) => {
                const myR = radii.get(node.id);
                const defaultDist = parentR + myR + GAP;
                const dist = Math.max(defaultDist, minDist || 0);
                const pos = {
                    x: parentPos.x + Math.cos(angle) * dist,
                    y: parentPos.y + Math.sin(angle) * dist
                };
                targets.set(node.id, pos);
                if (!node.children.length) return;

                const forwardLimit = Math.PI * 5 / 6;
                const effective = Math.min(sectorSize, forwardLimit);

                if (node.children.length === 1) {
                    // 单孩子：严格共线向外
                    placeNode(node.children[0], pos, myR, angle, effective, 0);
                    return;
                }

                const totalLeaves = node.children.reduce((s, c) => s + countLeaves(c), 0);
                const kids = node.children.map(c => {
                    const leaves = countLeaves(c);
                    return { node: c, leaves, sector: effective * (leaves / totalLeaves) };
                });
                // 让每个孩子的弧长(dist * sector)能容纳其子树宽度
                const needed = Math.max(
                    ...kids.map(k => approxWidth(k.node) / Math.max(k.sector, 0.05))
                );

                let cur = angle - effective / 2;
                kids.forEach(k => {
                    const cAngle = cur + k.sector / 2;
                    placeNode(k.node, pos, myR, cAngle, k.sector, needed);
                    cur += k.sector;
                });
            };

            // 为一批子树（都挂在 root 上）分配"上下两半圆"的扇区并放置
            const placeSubtreesAroundRoot = (rootId, subtrees) => {
                if (!subtrees.length) return;
                const rootPos = targets.get(rootId);
                const rootR = radii.get(rootId);

                // 叶子数均衡地分到上（y<0）/下（y>0）两半
                const annotated = subtrees
                    .map(st => ({ st, leaves: countLeaves(st) }))
                    .sort((a, b) => b.leaves - a.leaves);

                const upper = []; let upLeaves = 0;
                const lower = []; let loLeaves = 0;
                annotated.forEach(({ st, leaves }) => {
                    if (upLeaves <= loLeaves) { upper.push(st); upLeaves += leaves; }
                    else { lower.push(st); loLeaves += leaves; }
                });

                // 半圆中心角：下 = π/2（canvas y 正向 = 下）、上 = 3π/2（y 负向 = 上）
                // 留一点 padding 避让主链方向（0, π）
                const placeHalf = (sts, center) => {
                    if (!sts.length) return;
                    const totalSpan = Math.PI * 5 / 6;  // 150°，给链轴留出 15° 空隙
                    const total = sts.reduce((s, x) => s + countLeaves(x), 0);
                    // 根据最宽子树 / 其扇形反算第一层最小径向距离
                    const needed = Math.max(
                        ...sts.map(st => {
                            const leaves = countLeaves(st);
                            const span = totalSpan * (leaves / total);
                            return approxWidth(st) / Math.max(span, 0.05);
                        })
                    );
                    let cur = center - totalSpan / 2;
                    sts.forEach(st => {
                        const leaves = countLeaves(st);
                        const span = totalSpan * (leaves / total);
                        const a = cur + span / 2;
                        placeNode(st, rootPos, rootR, a, span, needed);
                        cur += span;
                    });
                };

                placeHalf(upper, 3 * Math.PI / 2);
                placeHalf(lower, Math.PI / 2);
            };

            // Pass A：每个主链实体的分支
            mainPath.filter(isEnt).forEach(eid => {
                const branchRels = Array.from(coreAdj.get(eid) || [])
                    .filter(r => isRel(r) && !placed.has(r))
                    .sort();
                if (!branchRels.length) return;
                const subtrees = [];
                branchRels.forEach(rid => {
                    // 同样要求有未放置实体邻居（或一元关系）
                    const relEnts = Array.from(coreAdj.get(rid) || []).filter(isEnt);
                    const hasUnplacedEnt = relEnts.some(e => e !== eid && !placed.has(e));
                    const isUnary = relEnts.length === 1;
                    if (hasUnplacedEnt || isUnary) {
                        subtrees.push(buildRelSubtree(rid, eid));
                    }
                });
                placeSubtreesAroundRoot(eid, subtrees);
            });

            // Pass B：主链关系（如三元关系）上挂着的非主链实体
            mainPath.filter(isRel).forEach(rid => {
                const extraEnts = Array.from(coreAdj.get(rid) || [])
                    .filter(e => isEnt(e) && !placed.has(e))
                    .sort();
                if (!extraEnts.length) return;
                const subtrees = extraEnts.map(eid => {
                    placed.add(eid);
                    return buildEntityNode(eid);
                });
                placeSubtreesAroundRoot(rid, subtrees);
            });

            // Pass C：与主链完全不相连但在同一分量内的残余（通常因为"弦" relationship
            // 本身未挂实体，但其他路径应已覆盖）。保险起见再扫一遍。
            ids.forEach(id => {
                if (placed.has(id)) return;
                if (!isEnt(id)) return;
                placed.add(id);
                const subtree = buildEntityNode(id);
                // 找一个已放置的邻居做锚；没有就放在原点附近
                const anchorId = Array.from(coreAdj.get(id) || []).find(x => placed.has(x));
                if (anchorId) {
                    const aPos = targets.get(anchorId);
                    const aR = radii.get(anchorId);
                    placeNode(subtree, aPos, aR, Math.PI / 2, Math.PI * 2 / 3, 0);
                } else {
                    targets.set(id, { x: 0, y: 0 });
                    placeNode(subtree, { x: 0, y: 0 }, 0, Math.PI / 2, Math.PI * 2 / 3, 0);
                }
            });

            // Pass D：弦 —— 两端实体都已放置的关系菱形
            ids.forEach(id => {
                if (placed.has(id)) return;
                if (!isRel(id)) return;
                const ents = Array.from(coreAdj.get(id) || []).filter(isEnt);
                const placedEnts = ents.filter(e => targets.has(e));
                if (!placedEnts.length) return;
                const myR = radii.get(id);

                if (placedEnts.length === 1) {
                    const p = targets.get(placedEnts[0]);
                    const r = radii.get(placedEnts[0]);
                    // 自关联：放在实体正下方一点
                    targets.set(id, { x: p.x, y: p.y + r + myR + GAP });
                } else {
                    // 中点 + 垂直偏移（避免落到主链轴上）
                    let mx = 0, my = 0;
                    placedEnts.forEach(e => {
                        const p = targets.get(e);
                        mx += p.x; my += p.y;
                    });
                    mx /= placedEnts.length;
                    my /= placedEnts.length;

                    // 主方向（从第一个端点到第二个端点）
                    const p1 = targets.get(placedEnts[0]);
                    const p2 = targets.get(placedEnts[1]);
                    const dx = p2.x - p1.x;
                    const dy = p2.y - p1.y;
                    const len = Math.hypot(dx, dy) || 1;
                    // 垂直向量，偏向已经较少占用的一侧（简单：用 id 决定性哈希）
                    let perpX = -dy / len, perpY = dx / len;
                    const flip = (deterministicHash(id) % 2) === 0 ? 1 : -1;
                    perpX *= flip; perpY *= flip;
                    const off = Math.max(myR + 60, len * 0.22);
                    targets.set(id, { x: mx + perpX * off, y: my + perpY * off });
                }
                placed.add(id);
            });

            // 兜底
            ids.forEach(id => {
                if (!targets.has(id)) {
                    const m = nodeMap.get(id)?.getModel();
                    targets.set(id, { x: m?.x || 0, y: m?.y || 0 });
                }
            });

            // bounds
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            targets.forEach((pos, id) => {
                const r = radii.get(id) || 30;
                minX = Math.min(minX, pos.x - r);
                maxX = Math.max(maxX, pos.x + r);
                minY = Math.min(minY, pos.y - r);
                maxY = Math.max(maxY, pos.y + r);
            });

            return { targets, bounds: { minX, maxX, minY, maxY }, mainPathSet };
        };

        const componentLayouts = components.map(layoutComponent);

        // ------- 多分量平铺 -------
        const globalTargets = new Map();
        const componentGap = 240;
        let cursorX = componentGap;
        let cursorY = componentGap;
        let rowHeight = 0;
        const mainChainIds = new Set();

        componentLayouts.forEach(layout => {
            const { minX, maxX, minY, maxY } = layout.bounds;
            const width = (maxX - minX) + componentGap;
            const height = (maxY - minY) + componentGap;
            if (cursorX + width > containerWidth - componentGap / 2) {
                cursorX = componentGap;
                cursorY += rowHeight + componentGap;
                rowHeight = 0;
            }
            const offsetX = cursorX - minX;
            const offsetY = cursorY - minY;
            layout.targets.forEach((pos, id) => {
                globalTargets.set(id, { x: pos.x + offsetX, y: pos.y + offsetY });
            });
            layout.mainPathSet.forEach(id => mainChainIds.add(id));
            cursorX += width;
            rowHeight = Math.max(rowHeight, height);
        });

        // 记录主链位置（作为固定锚点，后续不许被 overlap 解析挪走）
        const mainAnchorPos = new Map();
        mainChainIds.forEach(id => {
            const p = globalTargets.get(id);
            if (p) mainAnchorPos.set(id, { ...p });
        });

        // ------- 属性椭圆围绕放置 -------
        entityAttrs.forEach((attrs, eid) => {
            const center = globalTargets.get(eid);
            if (!center || !attrs.length) return;
            const entityR = getRadius(nodeMap.get(eid));
            const attrR = Math.max(...attrs.map(getRadius));
            const ring = entityR + attrR + 8;
            const relNeighbors = Array.from(coreAdj.get(eid) || []).filter(isRel);
            const relAngles = relNeighbors.map(rid => {
                const rp = globalTargets.get(rid);
                return rp ? normalizeAngle(Math.atan2(rp.y - center.y, rp.x - center.x)) : null;
            }).filter(a => a !== null);

            // 把 [0, 2π) 按关系角度切成弧段，按弧长按比例分配属性数
            const sortedRels = relAngles.slice().sort((a, b) => a - b);
            const arcs = [];
            if (!sortedRels.length) {
                arcs.push({ start: 0, length: Math.PI * 2, count: 0 });
            } else {
                const pad = 0.25; // 关系两侧的最小让位（弧度）
                for (let i = 0; i < sortedRels.length; i++) {
                    const a = sortedRels[i];
                    const b = sortedRels[(i + 1) % sortedRels.length] + (i === sortedRels.length - 1 ? Math.PI * 2 : 0);
                    const rawStart = a + pad;
                    const rawEnd = b - pad;
                    const len = rawEnd - rawStart;
                    if (len > 0.05) arcs.push({ start: rawStart, length: len, count: 0 });
                }
                if (!arcs.length) arcs.push({ start: 0, length: Math.PI * 2, count: 0 });
            }

            const totalLen = arcs.reduce((s, a) => s + a.length, 0);
            const sortedAttrs = attrs.slice().sort((a, b) => a.getModel().id.localeCompare(b.getModel().id));
            const n = sortedAttrs.length;
            let remaining = n;
            arcs.forEach(arc => {
                arc.count = Math.floor((arc.length / totalLen) * n);
                remaining -= arc.count;
            });
            // 按弧长倒序把剩余份额分给最长的弧
            const bySize = arcs.slice().sort((a, b) => b.length - a.length);
            for (let i = 0; i < remaining; i++) bySize[i % bySize.length].count += 1;

            let attrIdx = 0;
            arcs.forEach(arc => {
                for (let k = 1; k <= arc.count; k++) {
                    const ratio = k / (arc.count + 1);
                    const angle = normalizeAngle(arc.start + arc.length * ratio);
                    const attrNode = sortedAttrs[attrIdx++];
                    globalTargets.set(attrNode.getModel().id, {
                        x: center.x + Math.cos(angle) * ring,
                        y: center.y + Math.sin(angle) * ring
                    });
                }
            });
            // 兜底
            while (attrIdx < n) {
                const attrNode = sortedAttrs[attrIdx];
                const angle = (attrIdx / n) * Math.PI * 2;
                globalTargets.set(attrNode.getModel().id, {
                    x: center.x + Math.cos(angle) * ring,
                    y: center.y + Math.sin(angle) * ring
                });
                attrIdx++;
            }
        });

        // 所有节点兜底
        allNodes.forEach(n => {
            const m = n.getModel();
            if (!globalTargets.has(m.id)) {
                globalTargets.set(m.id, { x: m.x || 0, y: m.y || 0 });
            }
        });

        // ------- 矩形/菱形防重叠（主链保持不动）-------
        const resolveCoreOverlaps = () => {
            const coreIds = coreNodes.map(n => n.getModel().id);
            const meta = coreIds.map(id => ({ id, r: getRadius(nodeMap.get(id)) }));
            for (let iter = 0; iter < 160; iter++) {
                let moved = 0;
                for (let i = 0; i < meta.length; i++) {
                    for (let j = i + 1; j < meta.length; j++) {
                        const a = meta[i], b = meta[j];
                        const pa = globalTargets.get(a.id);
                        const pb = globalTargets.get(b.id);
                        if (!pa || !pb) continue;
                        const dx = pb.x - pa.x;
                        const dy = pb.y - pa.y;
                        let dist = Math.hypot(dx, dy);
                        if (dist === 0) dist = 0.01;
                        const minDist = a.r + b.r + 16;
                        if (dist < minDist) {
                            const overlap = (minDist - dist);
                            const aLocked = mainChainIds.has(a.id);
                            const bLocked = mainChainIds.has(b.id);
                            const pushA = aLocked ? 0 : overlap / (bLocked ? 1 : 2);
                            const pushB = bLocked ? 0 : overlap / (aLocked ? 1 : 2);
                            const nx = dx / dist, ny = dy / dist;
                            pa.x -= nx * pushA; pa.y -= ny * pushA;
                            pb.x += nx * pushB; pb.y += ny * pushB;
                            moved = Math.max(moved, Math.max(pushA, pushB));
                        }
                    }
                }
                if (moved < 0.5) break;
            }
        };
        resolveCoreOverlaps();

        // 恢复主链（resolveCoreOverlaps 内其实已经锁定，这里双保险）
        mainAnchorPos.forEach((pos, id) => {
            globalTargets.set(id, { ...pos });
        });

        animateNodesToTargets(graph, globalTargets, 800, () => {
            graph.refreshPositions();
            setTimeout(() => smoothFitView(graph, 700, 'easeOutCubic'), 120);
        });
    };
