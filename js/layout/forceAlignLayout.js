/**
 * Force Align Layout Module
 * Contains the force align layout algorithm:
 * - Ignores ellipses (attributes), aligns main chain horizontally
 * - Recursively distributes branch nodes evenly
 */

(function (exports) {
    'use strict';

    // 获取工具函数和动画函数
    const getUtils = () => exports.LayoutUtils || {};
    const getAnimation = () => exports.LayoutAnimation || {};

    /**
     * 强制对齐布局：忽略椭圆，主链水平，支线递归均分
     * @param {Object} graph - G6 图形实例
     * @param {number} containerWidth - 容器宽度
     */
    const forceAlignLayout = (graph, containerWidth) => {
        const { deterministicHash, normalizeAngle } = getUtils();
        const { smoothFitView, animateNodesToTargets } = getAnimation();

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
            if (isCore(m.nodeType)) {
                coreNodes.push(n);
            } else if (m.nodeType === 'attribute') {
                attributeNodes.push(n);
            }
        });
        if (!coreNodes.length) return;

        // 实体 -> 属性列表
        const entityAttrs = new Map();
        attributeNodes.forEach(attr => {
            const pid = attr.getModel().parentEntity;
            if (!pid) return;
            if (!entityAttrs.has(pid)) entityAttrs.set(pid, []);
            entityAttrs.get(pid).push(attr);
        });
        const sideHint = new Map();

        const getRadius = (node) => {
            const b = node.getBBox();
            return Math.sqrt(b.width * b.width + b.height * b.height) / 2;
        };

        // 仅矩形/菱形的邻接表
        const coreAdj = new Map();
        graph.getEdges().forEach(edge => {
            const { source, target } = edge.getModel();
            const sNode = nodeMap.get(source);
            const tNode = nodeMap.get(target);
            if (!sNode || !tNode) return;
            const sType = sNode.getModel().nodeType;
            const tType = tNode.getModel().nodeType;
            if (isCore(sType) && isCore(tType)) {
                if (!coreAdj.has(source)) coreAdj.set(source, new Set());
                if (!coreAdj.has(target)) coreAdj.set(target, new Set());
                coreAdj.get(source).add(target);
                coreAdj.get(target).add(source);
            }
        });
        if (!coreAdj.size) return;

        // 划分核心组件
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
                const neighbors = coreAdj.get(cur);
                if (!neighbors) continue;
                neighbors.forEach(nb => {
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
                const neighbors = coreAdj.get(cur);
                if (!neighbors) continue;
                neighbors.forEach(nb => {
                    if (!allowed.has(nb) || dist.has(nb)) return;
                    dist.set(nb, dist.get(cur) + 1);
                    prev.set(nb, cur);
                    queue.push(nb);
                });
            }
            let farthest = start;
            dist.forEach((d, id) => {
                if (d > dist.get(farthest)) farthest = id;
            });
            return { farthest, dist, prev };
        };

        const findLongestPath = (ids) => {
            const allowed = new Set(ids);
            const first = ids[0];
            const { farthest: endA } = bfsFarthest(first, allowed);
            const { farthest: endB, prev } = bfsFarthest(endA, allowed);
            const path = [];
            let cur = endB;
            while (cur !== undefined) {
                path.unshift(cur);
                cur = prev.get(cur);
            }
            return path.length ? path : [first];
        };

        const layoutComponent = (ids) => {
            const targets = new Map();
            const radiiCache = new Map();
            ids.forEach(id => radiiCache.set(id, getRadius(nodeMap.get(id))));
            const maxRadius = Math.max(...radiiCache.values());
            const chainSpacing = Math.max(200, maxRadius * 2 + 40);
            const mainPathSet = new Set();
            let altSide = 1;

            const mainPath = findLongestPath(ids);
            const startX = -((mainPath.length - 1) * chainSpacing) / 2;
            mainPath.forEach((id, idx) => {
                targets.set(id, { x: startX + idx * chainSpacing, y: 0 });
                mainPathSet.add(id);
                const isEntity = nodeMap.get(id)?.getModel().nodeType === 'entity';
                if (isEntity) sideHint.set(id, 0);
            });

            // 预先给所有非主链节点划分分支组件并确定侧向
            const nonMain = ids.filter(id => !mainPathSet.has(id));
            const branchVisited = new Set();
            nonMain.forEach(id => {
                if (branchVisited.has(id)) return;
                const stack = [id];
                const comp = [];
                branchVisited.add(id);
                while (stack.length) {
                    const cur = stack.pop();
                    comp.push(cur);
                    (coreAdj.get(cur) || []).forEach(nb => {
                        if (branchVisited.has(nb) || mainPathSet.has(nb)) return;
                        branchVisited.add(nb);
                        stack.push(nb);
                    });
                }
                if (!comp.length) return;

                const anchors = new Set();
                comp.forEach(nid => {
                    (coreAdj.get(nid) || []).forEach(nb => {
                        if (mainPathSet.has(nb)) anchors.add(nb);
                    });
                });

                let compSign = 0;
                comp.some(nid => {
                    const s = sideHint.get(nid);
                    if (s) {
                        compSign = s;
                        return true;
                    }
                    return false;
                });
                if (compSign === 0) {
                    Array.from(anchors).some(aid => {
                        const s = sideHint.get(aid);
                        if (s) {
                            compSign = s;
                            return true;
                        }
                        return false;
                    });
                }
                if (compSign === 0) {
                    compSign = altSide;
                    altSide = -altSide;
                }
                comp.forEach(nid => sideHint.set(nid, compSign));
            });

            const queue = mainPath.filter(id => nodeMap.get(id)?.getModel().nodeType === 'entity');

            const computeExtraAngles = (anchors, extraCount, preferredSign = 0) => {
                if (extraCount <= 0) return [];

                if (preferredSign !== 0) {
                    const halfStart = preferredSign > 0 ? 0 : Math.PI;
                    const halfEnd = halfStart + Math.PI;
                    const anchorInHalf = anchors
                        .map(normalizeAngle)
                        .filter(a => a >= halfStart && a < halfEnd)
                        .sort((a, b) => a - b);

                    const points = [halfStart, ...anchorInHalf, halfEnd];
                    const arcs = [];
                    for (let i = 0; i < points.length - 1; i++) {
                        const start = points[i];
                        const length = points[i + 1] - points[i];
                        arcs.push({ start, length, extras: 0, fraction: 0 });
                    }

                    const totalLen = arcs.reduce((sum, a) => sum + a.length, 0) || Math.PI;
                    let remaining = extraCount;
                    arcs.forEach(arc => {
                        const ideal = (arc.length / totalLen) * extraCount;
                        arc.extras = Math.floor(ideal);
                        arc.fraction = ideal - arc.extras;
                        remaining -= arc.extras;
                    });

                    arcs.sort((a, b) => b.fraction - a.fraction);
                    for (let i = 0; i < remaining; i++) {
                        arcs[i % arcs.length].extras += 1;
                    }
                    arcs.sort((a, b) => a.start - b.start);

                    const result = [];
                    arcs.forEach(arc => {
                        if (arc.length <= 1e-6 || arc.extras <= 0) return;
                        for (let k = 1; k <= arc.extras; k++) {
                            const ratio = k / (arc.extras + 1);
                            result.push(normalizeAngle(arc.start + arc.length * ratio));
                        }
                    });

                    if (!result.length) {
                        const step = Math.PI / (extraCount + 1);
                        for (let i = 0; i < extraCount; i++) {
                            result.push(normalizeAngle(halfStart + step * (i + 1)));
                        }
                    }
                    return result.sort((a, b) => a - b);
                }

                if (!anchors.length) {
                    const step = (Math.PI * 2) / extraCount;
                    return new Array(extraCount).fill(0).map((_, i) => normalizeAngle(step * i));
                }

                const sortedAnchors = anchors.slice().sort((a, b) => a - b);
                const extended = sortedAnchors.concat([sortedAnchors[0] + Math.PI * 2]);

                const arcs = [];
                for (let i = 0; i < sortedAnchors.length; i++) {
                    const start = extended[i];
                    const length = extended[i + 1] - extended[i];
                    arcs.push({ start, length, extras: 0, fraction: 0 });
                }

                const totalLen = arcs.reduce((sum, a) => sum + a.length, 0);
                let remaining = extraCount;
                arcs.forEach(arc => {
                    const ideal = (arc.length / totalLen) * extraCount;
                    arc.extras = Math.floor(ideal);
                    arc.fraction = ideal - arc.extras;
                    remaining -= arc.extras;
                });

                arcs.sort((a, b) => b.fraction - a.fraction);
                for (let i = 0; i < remaining; i++) {
                    arcs[i % arcs.length].extras += 1;
                }
                arcs.sort((a, b) => a.start - b.start);

                const result = [];
                arcs.forEach(arc => {
                    for (let k = 1; k <= arc.extras; k++) {
                        const ratio = k / (arc.extras + 1);
                        result.push(normalizeAngle(arc.start + arc.length * ratio));
                    }
                });

                return result.sort((a, b) => a - b);
            };

            while (queue.length) {
                const eid = queue.shift();
                const entityNode = nodeMap.get(eid);
                const entityPos = targets.get(eid);
                if (!entityNode || !entityPos) continue;
                const entityRadius = radiiCache.get(eid);
                const preferredSign = sideHint.get(eid) || 0;
                let nextAltSign = preferredSign === 0 ? 1 : preferredSign;

                const relNeighbors = Array.from(coreAdj.get(eid) || []).filter(id => nodeMap.get(id)?.getModel().nodeType === 'relationship');
                if (!relNeighbors.length) continue;

                const anchorRels = relNeighbors.filter(rid => targets.has(rid));
                const unplacedRels = relNeighbors.filter(rid => !targets.has(rid));
                const anchorAngles = anchorRels.map(rid => {
                    const rPos = targets.get(rid);
                    return normalizeAngle(Math.atan2(rPos.y - entityPos.y, rPos.x - entityPos.x));
                });

                const unplacedInfo = unplacedRels.map(rid => {
                    const others = Array.from(coreAdj.get(rid) || []).filter(id => nodeMap.get(id)?.getModel().nodeType === 'entity' && id !== eid);
                    return { rid, others };
                });

                const relAdj = new Map();
                unplacedInfo.forEach(({ rid }) => relAdj.set(rid, new Set()));
                for (let i = 0; i < unplacedInfo.length; i++) {
                    for (let j = i + 1; j < unplacedInfo.length; j++) {
                        const a = unplacedInfo[i];
                        const b = unplacedInfo[j];
                        const shared = a.others.some(x => b.others.includes(x));
                        const cross = shared ? true : a.others.some(x => b.others.some(y => (coreAdj.get(x) || new Set()).has(y)));
                        if (shared || cross) {
                            relAdj.get(a.rid).add(b.rid);
                            relAdj.get(b.rid).add(a.rid);
                        }
                    }
                }

                const compVisited = new Set();
                const relComponents = [];
                unplacedRels.forEach(rid => {
                    if (compVisited.has(rid)) return;
                    const stack = [rid];
                    const comp = [];
                    compVisited.add(rid);
                    while (stack.length) {
                        const cur = stack.pop();
                        comp.push(cur);
                        (relAdj.get(cur) || []).forEach(nb => {
                            if (!compVisited.has(nb)) {
                                compVisited.add(nb);
                                stack.push(nb);
                            }
                        });
                    }
                    relComponents.push(comp);
                });

                const anchorAnglesWithSign = anchorRels.map(rid => {
                    const ang = anchorAngles[anchorRels.indexOf(rid)];
                    const sign = sideHint.get(rid) || Math.sign(Math.sin(ang)) || 0;
                    return { ang, sign };
                });

                relComponents.forEach((comp, compIdx) => {
                    let compSign = 0;
                    comp.some(rid => {
                        const relSign = sideHint.get(rid);
                        if (relSign) {
                            compSign = relSign;
                            return true;
                        }
                        const others = unplacedInfo.find(i => i.rid === rid)?.others || [];
                        const entSign = others.map(id => sideHint.get(id)).find(s => s);
                        if (entSign) {
                            compSign = entSign;
                            return true;
                        }
                        return false;
                    });
                    if (compSign === 0) {
                        compSign = nextAltSign;
                        nextAltSign = -nextAltSign;
                    }

                    const anchorsForSide = anchorAnglesWithSign
                        .filter(a => compSign > 0 ? a.sign >= 0 : a.sign <= 0)
                        .map(a => a.ang);

                    const angles = computeExtraAngles(anchorsForSide.length ? anchorsForSide : anchorAngles, comp.length, compSign);
                    const sortedComp = comp.slice().sort((a, b) => a.localeCompare(b));
                    sortedComp.forEach((rid, idx) => {
                        const relRadius = radiiCache.get(rid);
                        const angle = angles[idx % angles.length] ?? normalizeAngle((Math.PI * (compSign > 0 ? 0.5 : 1.5)) + (idx * 0.2));
                        const dist = entityRadius + relRadius + 40;
                        targets.set(rid, {
                            x: entityPos.x + Math.cos(angle) * dist,
                            y: entityPos.y + Math.sin(angle) * dist
                        });
                        const sign = Math.sign(Math.sin(angle)) || compSign || (preferredSign || 1);
                        if (!sideHint.has(rid)) sideHint.set(rid, sign);
                    });
                });

                relNeighbors.forEach(rid => {
                    const relPos = targets.get(rid);
                    if (!relPos) return;
                    const relRadius = radiiCache.get(rid);
                    const angle = Math.atan2(relPos.y - entityPos.y, relPos.x - entityPos.x);
                    const neighbors = Array.from(coreAdj.get(rid) || []).filter(id => nodeMap.get(id)?.getModel().nodeType === 'entity' && id !== eid);
                    neighbors.forEach(otherId => {
                        if (targets.has(otherId)) return;
                        const otherNode = nodeMap.get(otherId);
                        const otherRadius = radiiCache.get(otherId);
                        const dist = entityRadius + relRadius + otherRadius + 80;
                        targets.set(otherId, {
                            x: entityPos.x + Math.cos(angle) * dist,
                            y: entityPos.y + Math.sin(angle) * dist
                        });
                        const sign = Math.sign(Math.sin(angle)) || sideHint.get(rid) || sideHint.get(eid) || 1;
                        if (!sideHint.has(otherId)) sideHint.set(otherId, sign);
                        queue.push(otherId);
                    });
                });
            }

            ids.forEach(id => {
                if (!targets.has(id)) {
                    const model = nodeMap.get(id)?.getModel();
                    targets.set(id, { x: model?.x || 0, y: model?.y || 0 });
                }
            });

            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            targets.forEach((pos, id) => {
                const r = radiiCache.get(id);
                minX = Math.min(minX, pos.x - r);
                maxX = Math.max(maxX, pos.x + r);
                minY = Math.min(minY, pos.y - r);
                maxY = Math.max(maxY, pos.y + r);
            });

            return { targets, bounds: { minX, maxX, minY, maxY }, mainPathSet };
        };

        const componentLayouts = components.map(layoutComponent);

        // 平铺组件
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

        // 记录主线初始位置
        const mainAnchorPos = new Map();
        mainChainIds.forEach(id => {
            const p = globalTargets.get(id);
            if (p) mainAnchorPos.set(id, { ...p });
        });

        // 对每个实体，将同侧关系均分半圆
        const evenSideSpacing = () => {
            const entityIds = coreNodes.filter(n => n.getModel().nodeType === 'entity').map(n => n.getModel().id);
            entityIds.forEach(eid => {
                const entityPos = globalTargets.get(eid);
                if (!entityPos) return;
                const entityRadius = getRadius(nodeMap.get(eid));
                const relNeighbors = Array.from(coreAdj.get(eid) || []).filter(id => nodeMap.get(id)?.getModel().nodeType === 'relationship');
                if (!relNeighbors.length) return;

                const up = [];
                const down = [];
                relNeighbors.forEach(rid => {
                    const pos = globalTargets.get(rid);
                    const known = sideHint.get(rid);
                    const sign = known || (pos ? Math.sign(pos.y - entityPos.y) : 0) || 1;
                    if (sign >= 0) up.push(rid); else down.push(rid);
                });

                const place = (list, sign) => {
                    if (!list.length) return;
                    const jitter = ((deterministicHash(`${eid}-${sign}`) % 1000) / 1000) * 0.35 - 0.175;
                    const start = (sign > 0 ? 0 : Math.PI) + jitter;
                    const step = Math.PI / (list.length + 1);
                    const maxRelR = Math.max(...list.map(rid => getRadius(nodeMap.get(rid))));
                    const radius = entityRadius + maxRelR + 40;
                    const sorted = list.slice().sort((a, b) => a.localeCompare(b));
                    sorted.forEach((rid, idx) => {
                        const ang = start + step * (idx + 1);
                        globalTargets.set(rid, {
                            x: entityPos.x + Math.cos(ang) * radius,
                            y: entityPos.y + Math.sin(ang) * radius
                        });
                        sideHint.set(rid, sign);
                    });
                };

                place(up.filter(id => !mainChainIds.has(id)), 1);
                place(down.filter(id => !mainChainIds.has(id)), -1);
            });
        };

        evenSideSpacing();

        // 保持分支顺序
        const projectedEntities = new Set();
        const reprojectBranches = () => {
            const entityIds = coreNodes.filter(n => n.getModel().nodeType === 'entity').map(n => n.getModel().id);
            entityIds.forEach(eid => {
                const ePos = globalTargets.get(eid);
                if (!ePos) return;
                const eRad = getRadius(nodeMap.get(eid));
                const relNeighbors = Array.from(coreAdj.get(eid) || []).filter(id => nodeMap.get(id)?.getModel().nodeType === 'relationship');
                relNeighbors.forEach(rid => {
                    const rPos = globalTargets.get(rid);
                    if (!rPos) return;
                    if (mainChainIds.has(rid)) return;
                    const rRad = getRadius(nodeMap.get(rid));
                    const ang = Math.atan2(rPos.y - ePos.y, rPos.x - ePos.x);

                    const neighbors = Array.from(coreAdj.get(rid) || []).filter(id => nodeMap.get(id)?.getModel().nodeType === 'entity' && id !== eid);
                    neighbors.forEach(oid => {
                        if (mainChainIds.has(oid)) return;
                        const oNode = nodeMap.get(oid);
                        if (!oNode) return;
                        const oRad = getRadius(oNode);
                        const dist = eRad + rRad + oRad + 80;
                        const existing = globalTargets.get(oid);
                        const newPos = {
                            x: ePos.x + Math.cos(ang) * dist,
                            y: ePos.y + Math.sin(ang) * dist
                        };
                        if (!existing || projectedEntities.has(oid)) {
                            globalTargets.set(oid, newPos);
                        } else {
                            const curDist = Math.hypot(existing.x - ePos.x, existing.y - ePos.y);
                            if (dist > curDist) {
                                globalTargets.set(oid, newPos);
                            }
                        }
                        projectedEntities.add(oid);
                        const sign = Math.sign(Math.sin(ang)) || sideHint.get(rid) || sideHint.get(eid) || 1;
                        sideHint.set(oid, sign);
                    });
                });
            });
        };

        reprojectBranches();

        // 强制本地直线
        const enforceLocalTriplets = () => {
            coreNodes.forEach(relNode => {
                const rm = relNode.getModel();
                if (rm.nodeType !== 'relationship') return;
                const entNeighbors = Array.from(coreAdj.get(rm.id) || []).filter(id => nodeMap.get(id)?.getModel().nodeType === 'entity');
                if (entNeighbors.length !== 2) return;
                const [e1, e2] = entNeighbors;
                if (mainChainIds.has(e1) && mainChainIds.has(e2) && mainChainIds.has(rm.id)) return;
                const pR = globalTargets.get(rm.id);
                const p1 = globalTargets.get(e1);
                const p2 = globalTargets.get(e2);
                if (!pR || !p1 || !p2) return;

                const d1 = Math.hypot(pR.x - p1.x, pR.y - p1.y);
                const d2 = Math.hypot(pR.x - p2.x, pR.y - p2.y);
                const anchor = d1 <= d2 ? p1 : p2;
                const moveTarget = d1 <= d2 ? e2 : e1;
                if (mainChainIds.has(moveTarget)) return;

                const dx = pR.x - anchor.x;
                const dy = pR.y - anchor.y;
                const len = Math.hypot(dx, dy) || 1;
                const ux = dx / len;
                const uy = dy / len;
                const movePos = globalTargets.get(moveTarget);
                const moveRad = getRadius(nodeMap.get(moveTarget));
                const newPos = {
                    x: pR.x + ux * (moveRad + getRadius(relNode) + 20),
                    y: pR.y + uy * (moveRad + getRadius(relNode) + 20)
                };
                globalTargets.set(moveTarget, newPos);
            });
        };

        enforceLocalTriplets();

        // 让非主线的两端关系菱形落在两实体中点
        const adjustRelationshipMidpoints = () => {
            coreNodes.forEach(relNode => {
                const rm = relNode.getModel();
                if (rm.nodeType !== 'relationship') return;
                if (mainChainIds.has(rm.id)) return;
                const entNeighbors = Array.from(coreAdj.get(rm.id) || []).filter(id => nodeMap.get(id)?.getModel().nodeType === 'entity');
                if (entNeighbors.length !== 2) return;
                const [e1, e2] = entNeighbors;
                const p1 = globalTargets.get(e1);
                const p2 = globalTargets.get(e2);
                if (!p1 || !p2) return;
                const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                if (!dist) return;
                const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
                const rRel = getRadius(relNode);
                const r1 = getRadius(nodeMap.get(e1));
                const r2 = getRadius(nodeMap.get(e2));
                const minSpan = r1 + r2 + rRel * 2 + 40;
                if (dist < minSpan) return;
                globalTargets.set(rm.id, mid);
            });
        };

        adjustRelationshipMidpoints();

        // 末尾再放椭圆
        entityAttrs.forEach((attrs, eid) => {
            const center = globalTargets.get(eid);
            if (!center || !attrs.length) return;
            const entityNode = nodeMap.get(eid);
            const entityR = getRadius(entityNode);
            const attrR = Math.max(...attrs.map(getRadius));
            const baseRing = entityR + attrR + 8;
            const relNeighbors = Array.from(coreAdj.get(eid) || []).filter(id => nodeMap.get(id)?.getModel().nodeType === 'relationship');
            const relAngles = relNeighbors.map(rid => {
                const rp = globalTargets.get(rid);
                return rp ? normalizeAngle(Math.atan2(rp.y - center.y, rp.x - center.x)) : 0;
            });
            const step = (Math.PI * 2) / attrs.length;
            const sortedAttrs = attrs.slice().sort((a, b) => a.getModel().id.localeCompare(b.getModel().id));
            sortedAttrs.forEach((attrNode, idx) => {
                const seed = deterministicHash(attrNode.getModel().id, idx) % 1000 / 1000;
                let angle = normalizeAngle(step * idx + step * 0.35 + (seed - 0.5) * 0.2);
                const threshold = 0.12;
                for (let t = 0; t < attrs.length; t++) {
                    const candidate = normalizeAngle(angle + t * (step / (attrs.length + 1)));
                    const tooClose = relAngles.some(ra => {
                        const diff = Math.abs(candidate - ra);
                        const mind = Math.min(diff, Math.PI * 2 - diff);
                        return mind < threshold;
                    });
                    if (!tooClose) {
                        angle = candidate;
                        break;
                    }
                }
                globalTargets.set(attrNode.getModel().id, {
                    x: center.x + Math.cos(angle) * baseRing,
                    y: center.y + Math.sin(angle) * baseRing
                });
            });
        });

        // 确保每个节点都有目标
        allNodes.forEach(n => {
            const m = n.getModel();
            if (!globalTargets.has(m.id)) {
                globalTargets.set(m.id, { x: m.x || 0, y: m.y || 0 });
            }
        });

        // 矩形/菱形全局防重叠
        const resolveCoreOverlaps = () => {
            const coreIds = coreNodes.map(n => n.getModel().id);
            const meta = coreIds.map(id => ({ id, r: getRadius(nodeMap.get(id)) }));
            for (let iter = 0; iter < 120; iter++) {
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
                        const minDist = a.r + b.r + 14;
                        if (dist < minDist) {
                            const overlap = (minDist - dist);
                            const pushA = mainChainIds.has(a.id) ? 0 : overlap / (mainChainIds.has(b.id) ? 1 : 2);
                            const pushB = mainChainIds.has(b.id) ? 0 : overlap / (mainChainIds.has(a.id) ? 1 : 2);
                            const nx = dx / dist;
                            const ny = dy / dist;
                            pa.x -= nx * pushA;
                            pa.y -= ny * pushA;
                            pb.x += nx * pushB;
                            pb.y += ny * pushB;
                            moved = Math.max(moved, Math.max(pushA, pushB));
                        }
                    }
                }
                if (moved < 0.5) break;
            }
        };

        resolveCoreOverlaps();

        // 恢复主线固定位置
        mainAnchorPos.forEach((pos, id) => {
            globalTargets.set(id, { ...pos });
        });

        animateNodesToTargets(graph, globalTargets, 800, () => {
            graph.refreshPositions();
            setTimeout(() => smoothFitView(graph, 700, 'easeOutCubic'), 120);
        });
    };

    // 初始化 LayoutForceAlign 命名空间
    if (!exports.LayoutForceAlign) {
        exports.LayoutForceAlign = {};
    }

    // 导出函数
    Object.assign(exports.LayoutForceAlign, {
        forceAlignLayout
    });

})(window);
