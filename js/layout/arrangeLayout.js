/**
 * Arrange Layout Module
 * Contains the arrange layout algorithm:
 * - Evenly distribute attributes around entities
 * - Handle relationship positioning between entities
 * - Spring-based collision detection and resolution
 */

(function (exports) {
    'use strict';

    // 获取动画函数
    const getAnimation = () => exports.LayoutAnimation || {};

    // ---- Spatial grid helpers (near-linear neighbor queries) ----
    const buildGrid = (items, cellSize) => {
        const grid = new Map();
        items.forEach(item => {
            const cx = Math.floor(item.pos.x / cellSize);
            const cy = Math.floor(item.pos.y / cellSize);
            const key = cx + ',' + cy;
            let bucket = grid.get(key);
            if (!bucket) { bucket = []; grid.set(key, bucket); }
            bucket.push(item);
        });
        return grid;
    };

    const forEachNeighbor = (grid, cellSize, item, cb) => {
        const cx = Math.floor(item.pos.x / cellSize);
        const cy = Math.floor(item.pos.y / cellSize);
        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                const bucket = grid.get((cx + ox) + ',' + (cy + oy));
                if (!bucket) continue;
                for (let k = 0; k < bucket.length; k++) cb(bucket[k]);
            }
        }
    };

    // ---- Segment-intersection test for crossing detection ----
    const segmentsCross = (a1, a2, b1, b2) => {
        // Proper-intersection test. Shared endpoints count as not crossing.
        const share = (p, q) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
        if (share(a1, b1) || share(a1, b2) || share(a2, b1) || share(a2, b2)) return false;
        const cross = (ox, oy, px, py, qx, qy) =>
            (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
        const d1 = cross(b1.x, b1.y, b2.x, b2.y, a1.x, a1.y);
        const d2 = cross(b1.x, b1.y, b2.x, b2.y, a2.x, a2.y);
        const d3 = cross(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y);
        const d4 = cross(a1.x, a1.y, a2.x, a2.y, b2.x, b2.y);
        return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
               ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
    };

    /**
     * 环绕排布布局：让属性均匀围绕实体，同时可移动实体以满足关系距离
     * @param {Object} graph - G6 图形实例
     */
    const arrangeLayout = (graph) => {
        const { smoothFitView, animateNodesToTargets } = getAnimation();

        if (!graph || graph.destroyed) return;

        const nodes = graph.getNodes();
        if (!nodes.length) return;

        const targets = new Map();
        const nodeMap = new Map();
        nodes.forEach(n => nodeMap.set(n.getModel().id, n));
        const relAnchors = new Map();
        const relRadii = new Map();

        const entityNodes = nodes.filter(n => n.getModel().nodeType === 'entity');
        const attributeNodes = nodes.filter(n => n.getModel().nodeType === 'attribute');
        const relationshipNodes = nodes.filter(n => n.getModel().nodeType === 'relationship');

        const getRadius = (node) => {
            const bbox = node.getBBox();
            return Math.sqrt(bbox.width * bbox.width + bbox.height * bbox.height) / 2;
        };

        const normalizeAngle = (a) => {
            let angle = a % (Math.PI * 2);
            if (angle < 0) angle += Math.PI * 2;
            return angle;
        };

        // 建立关系节点与实体节点的对应
        const relationshipConnections = new Map();
        graph.getEdges().forEach(edge => {
            const { source, target } = edge.getModel();
            const sourceNode = nodeMap.get(source);
            const targetNode = nodeMap.get(target);
            if (!sourceNode || !targetNode) return;
            const sType = sourceNode.getModel().nodeType;
            const tType = targetNode.getModel().nodeType;
            if (sType === 'relationship' && tType === 'entity') {
                if (!relationshipConnections.has(source)) relationshipConnections.set(source, new Set());
                relationshipConnections.get(source).add(targetNode);
            } else if (tType === 'relationship' && sType === 'entity') {
                if (!relationshipConnections.has(target)) relationshipConnections.set(target, new Set());
                relationshipConnections.get(target).add(sourceNode);
            }
        });

        // 按实体收集属性与关系
        const entityInfo = new Map();
        entityNodes.forEach(e => entityInfo.set(e.getModel().id, { node: e, attrs: [], rels: [], satellites: [] }));
        attributeNodes.forEach(a => {
            const pid = a.getModel().parentEntity;
            const info = entityInfo.get(pid);
            if (info) {
                info.attrs.push(a);
                info.satellites.push({ node: a, type: 'attr' });
            }
        });
        relationshipNodes.forEach(r => {
            const set = relationshipConnections.get(r.getModel().id);
            if (set) {
                const connected = Array.from(set);
                connected.forEach(entityNode => {
                    const info = entityInfo.get(entityNode.getModel().id);
                    if (!info) return;
                    const other = connected.find(n => n !== entityNode) || null;
                    info.rels.push({ relNode: r, otherEntity: other });
                    info.satellites.push({ node: r, type: 'rel', otherEntity: other });
                });
            }
        });

        // 当前实体坐标
        const entityPositions = new Map();
        entityNodes.forEach(n => {
            const m = n.getModel();
            entityPositions.set(m.id, { x: m.x, y: m.y });
        });

        // 计算每个实体的统一环绕半径
        const baseRing = new Map();
        const systemRadius = new Map();

        entityInfo.forEach(info => {
            const entityRadius = getRadius(info.node);
            const maxSatelliteRadius = info.satellites.length > 0
                ? Math.max(...info.satellites.map(s => getRadius(s.node)))
                : 30;

            let ringR = entityRadius + maxSatelliteRadius + 25;

            if (info.satellites.length > 1) {
                const count = info.satellites.length;
                const requiredArcLength = maxSatelliteRadius * 2 + 18;
                const totalCircumference = count * requiredArcLength;
                const requiredRingR = totalCircumference / (2 * Math.PI);
                ringR = Math.max(ringR, requiredRingR);
            }

            baseRing.set(info.node.getModel().id, ringR);
            systemRadius.set(info.node.getModel().id, ringR + maxSatelliteRadius);
        });

        // 构建双实体关系对(用于弹簧吸引 + 交叉检测)
        const relationshipPairs = [];
        relationshipNodes.forEach(relNode => {
            const set = relationshipConnections.get(relNode.getModel().id);
            if (!set || set.size !== 2) return;
            const [entityA, entityB] = Array.from(set.values());
            relationshipPairs.push({
                idA: entityA.getModel().id,
                idB: entityB.getModel().id,
                relNode
            });
        });

        // 邻接表：用于角度均分力
        const entityNeighbors = new Map();
        entityNodes.forEach(n => entityNeighbors.set(n.getModel().id, new Set()));
        relationshipPairs.forEach(pair => {
            entityNeighbors.get(pair.idA)?.add(pair.idB);
            entityNeighbors.get(pair.idB)?.add(pair.idA);
        });

        // 弹簧迭代：吸引只在"太近时推开"，保留用户已拉开的间距；排斥通过网格近邻加速
        const safeGap = 50;
        const entityIds = Array.from(entityPositions.keys());
        const maxSysR = entityIds.length
            ? Math.max(...entityIds.map(id => systemRadius.get(id) || 60))
            : 80;
        const entityCellSize = Math.max(120, (maxSysR * 2) + safeGap);

        for (let iter = 0; iter < 300; iter++) {
            let maxMove = 0;

            // 1. 约束力：相关实体互相"至少"这么近；已经近到位就不再拉近，避免破坏用户布局
            relationshipPairs.forEach(pair => {
                const posA = entityPositions.get(pair.idA);
                const posB = entityPositions.get(pair.idB);
                if (!posA || !posB) return;

                const dx = posB.x - posA.x;
                const dy = posB.y - posA.y;
                const dist = Math.hypot(dx, dy) || 1;

                const rA = systemRadius.get(pair.idA);
                const rB = systemRadius.get(pair.idB);
                const desired = rA + rB + safeGap;

                // 只有重叠时才推开，距离够就不再拉拢
                if (dist >= desired - 1) return;

                const diff = desired - dist;
                const nx = dx / dist;
                const ny = dy / dist;
                const move = (diff * 0.2) / 2;
                posA.x -= nx * move;
                posA.y -= ny * move;
                posB.x += nx * move;
                posB.y += ny * move;
                maxMove = Math.max(maxMove, Math.abs(move));
            });

            // 2. 全局斥力：网格近邻查找，O(n) 期望
            const entityItems = entityIds.map(id => ({
                id,
                pos: entityPositions.get(id),
                r: systemRadius.get(id)
            }));
            const grid = buildGrid(entityItems, entityCellSize);

            for (let i = 0; i < entityItems.length; i++) {
                const a = entityItems[i];
                forEachNeighbor(grid, entityCellSize, a, (b) => {
                    if (b.id <= a.id) return; // 避免重复处理 & 自身
                    const dx = b.pos.x - a.pos.x;
                    const dy = b.pos.y - a.pos.y;
                    const dist = Math.hypot(dx, dy) || 1;
                    const minDesc = a.r + b.r + safeGap;
                    if (dist < minDesc) {
                        const overlap = minDesc - dist;
                        const nx = dx / dist;
                        const ny = dy / dist;
                        const move = overlap * 0.25;
                        a.pos.x -= nx * move;
                        a.pos.y -= ny * move;
                        b.pos.x += nx * move;
                        b.pos.y += ny * move;
                        if (move > maxMove) maxMove = move;
                    }
                });
            }

            // 3. 角度均分力：仅在严重聚集时施加切向推力，避免成环图 (A-B-C 三角) 因目标
            //    不可达而持续漂移。Cap 单步弧长以抑制累积误差。
            entityIds.forEach(centerId => {
                const neighbors = entityNeighbors.get(centerId);
                if (!neighbors || neighbors.size < 2) return;
                const centerPos = entityPositions.get(centerId);
                if (!centerPos) return;

                const nArr = Array.from(neighbors);
                const idealStep = (Math.PI * 2) / nArr.length;
                // 仅在两邻居的夹角 < 理想间隔的一半时才视为严重聚集
                const activation = idealStep * 0.5;

                for (let i = 0; i < nArr.length; i++) {
                    const pi = entityPositions.get(nArr[i]);
                    if (!pi) continue;
                    const dxi = pi.x - centerPos.x;
                    const dyi = pi.y - centerPos.y;
                    const di = Math.hypot(dxi, dyi) || 1;
                    const ai = Math.atan2(dyi, dxi);

                    for (let j = i + 1; j < nArr.length; j++) {
                        const pj = entityPositions.get(nArr[j]);
                        if (!pj) continue;
                        const dxj = pj.x - centerPos.x;
                        const dyj = pj.y - centerPos.y;
                        const dj = Math.hypot(dxj, dyj) || 1;
                        const aj = Math.atan2(dyj, dxj);

                        let diff = aj - ai;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        while (diff <= -Math.PI) diff += Math.PI * 2;

                        const absDiff = Math.abs(diff);
                        if (absDiff >= activation) continue;

                        const shortfall = activation - absDiff;
                        const sign = diff >= 0 ? 1 : -1;
                        const tix = -dyi / di;
                        const tiy = dxi / di;
                        const tjx = -dyj / dj;
                        const tjy = dxj / dj;
                        let arc = shortfall * Math.min(di, dj) * 0.02;
                        if (arc > 2.5) arc = 2.5; // 硬上限：防止漂移累积
                        pj.x += tjx * arc * sign;
                        pj.y += tjy * arc * sign;
                        pi.x -= tix * arc * sign;
                        pi.y -= tiy * arc * sign;
                        if (arc > maxMove) maxMove = arc;
                    }
                }
            });

            if (maxMove < 0.5) break;
        }

        // ---- 2-opt 交叉消除：交换实体位置以减少关系边交叉 ----
        // 逻辑图：每个二元关系视为实体A→实体B的一条段；只关注段对的真相交。
        const countCrossings = () => {
            let total = 0;
            for (let i = 0; i < relationshipPairs.length; i++) {
                const pi = relationshipPairs[i];
                const a1 = entityPositions.get(pi.idA);
                const a2 = entityPositions.get(pi.idB);
                if (!a1 || !a2) continue;
                for (let j = i + 1; j < relationshipPairs.length; j++) {
                    const pj = relationshipPairs[j];
                    // 共享端点则不算交叉 (正常相交会在关系节点处汇合)
                    if (pi.idA === pj.idA || pi.idA === pj.idB ||
                        pi.idB === pj.idA || pi.idB === pj.idB) continue;
                    const b1 = entityPositions.get(pj.idA);
                    const b2 = entityPositions.get(pj.idB);
                    if (!b1 || !b2) continue;
                    if (segmentsCross(a1, a2, b1, b2)) total++;
                }
            }
            return total;
        };

        if (relationshipPairs.length >= 2 && entityIds.length >= 2) {
            let currentCrossings = countCrossings();
            if (currentCrossings > 0) {
                const maxSwapPasses = 8;
                for (let pass = 0; pass < maxSwapPasses && currentCrossings > 0; pass++) {
                    let improved = false;
                    for (let i = 0; i < entityIds.length && currentCrossings > 0; i++) {
                        for (let j = i + 1; j < entityIds.length; j++) {
                            const idA = entityIds[i];
                            const idB = entityIds[j];
                            const pa = entityPositions.get(idA);
                            const pb = entityPositions.get(idB);
                            if (!pa || !pb) continue;
                            // 试交换
                            const tmpX = pa.x, tmpY = pa.y;
                            pa.x = pb.x; pa.y = pb.y;
                            pb.x = tmpX; pb.y = tmpY;
                            const newCrossings = countCrossings();
                            if (newCrossings < currentCrossings) {
                                currentCrossings = newCrossings;
                                improved = true;
                                if (currentCrossings === 0) break;
                            } else {
                                // 回滚
                                pb.x = pa.x; pb.y = pa.y;
                                pa.x = tmpX; pa.y = tmpY;
                            }
                        }
                    }
                    if (!improved) break;
                }
            }
        }

        // 调整实体间距
        const ensureRelationshipClearance = () => {
            const clearanceGap = 12;

            relationshipNodes.forEach(relNode => {
                const relId = relNode.getModel().id;
                const connected = relationshipConnections.get(relId);
                if (!connected || connected.size !== 2) return;

                const [entityA, entityB] = Array.from(connected.values());
                const idA = entityA.getModel().id;
                const idB = entityB.getModel().id;
                const posA = entityPositions.get(idA);
                const posB = entityPositions.get(idB);
                if (!posA || !posB) return;

                const dx = posB.x - posA.x;
                const dy = posB.y - posA.y;
                const dist = Math.hypot(dx, dy) || 1;

                const relRadius = getRadius(relNode);
                const minHalf = Math.max(
                    (baseRing.get(idA) || 40) + relRadius + clearanceGap,
                    (baseRing.get(idB) || 40) + relRadius + clearanceGap
                );

                const requiredDist = minHalf * 2;
                if (dist >= requiredDist) return;

                const missing = requiredDist - dist;
                const nx = dx / dist;
                const ny = dy / dist;

                posA.x -= nx * missing / 2;
                posA.y -= ny * missing / 2;
                posB.x += nx * missing / 2;
                posB.y += ny * missing / 2;
            });
        };

        ensureRelationshipClearance();
        ensureRelationshipClearance();
        ensureRelationshipClearance();

        // 实体目标位置
        entityPositions.forEach((pos, id) => targets.set(id, { ...pos }));

        const entityOrbitRadius = new Map();

        // 统一布局所有卫星节点
        entityInfo.forEach(info => {
            const { node, satellites } = info;
            const model = node.getModel();
            const center = entityPositions.get(model.id) || { x: model.x, y: model.y };

            const ringRadius = baseRing.get(model.id);
            entityOrbitRadius.set(model.id, ringRadius);

            if (!satellites.length) return;

            const avoidAngles = [];
            satellites.forEach(s => {
                if (s.type === 'rel' && s.otherEntity) {
                    const otherPos = entityPositions.get(s.otherEntity.getModel().id);
                    if (otherPos) {
                        const angle = normalizeAngle(Math.atan2(otherPos.y - center.y, otherPos.x - center.x));
                        avoidAngles.push(angle);
                    }
                }
            });

            const gapAngle = 0.35;
            const halfGap = gapAngle / 2;
            let segments = [];

            if (!avoidAngles.length) {
                segments.push({ start: 0, end: Math.PI * 2 });
            } else {
                const sortedAngles = avoidAngles.slice().sort((a, b) => a - b);
                const total = Math.PI * 2;
                for (let i = 0; i < sortedAngles.length; i++) {
                    const curr = sortedAngles[i];
                    const next = sortedAngles[(i + 1) % sortedAngles.length] + (i === sortedAngles.length - 1 ? total : 0);
                    const start = curr + halfGap;
                    const end = next - halfGap;
                    if (end > start) segments.push({ start, end });
                }
            }

            const totalFree = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
            if (totalFree <= 0) {
                segments = [{ start: 0, end: Math.PI * 2 }];
            }

            const orbitalSatellites = satellites.filter(s =>
                s.type === 'attr' || (s.type === 'rel' && !s.otherEntity)
            );

            if (!orbitalSatellites.length) return;

            const sortedSatellites = orbitalSatellites.slice().sort((a, b) => {
                const ma = a.node.getModel();
                const mb = b.node.getModel();
                const angleA = normalizeAngle(Math.atan2(ma.y - center.y, ma.x - center.x));
                const angleB = normalizeAngle(Math.atan2(mb.y - center.y, mb.x - center.x));
                return angleA - angleB;
            });

            const totalCount = sortedSatellites.length;
            const totalAngle = segments.reduce((sum, s) => sum + (s.end - s.start), 0);

            const segCounts = segments.map(s =>
                Math.max(0, Math.round(totalCount * (s.end - s.start) / totalAngle))
            );

            let allocated = segCounts.reduce((sum, c) => sum + c, 0);
            while (allocated < totalCount) {
                let maxIdx = 0;
                let maxLen = -Infinity;
                segments.forEach((s, idx) => {
                    if (s.end - s.start > maxLen) {
                        maxLen = s.end - s.start;
                        maxIdx = idx;
                    }
                });
                segCounts[maxIdx]++;
                allocated++;
            }
            while (allocated > totalCount) {
                for (let i = segCounts.length - 1; i >= 0; i--) {
                    if (segCounts[i] > 0) {
                        segCounts[i]--;
                        allocated--;
                        break;
                    }
                }
            }

            let nodeIdx = 0;
            segments.forEach((s, idx) => {
                const count = segCounts[idx];
                if (!count) return;

                const step = (s.end - s.start) / count;

                for (let i = 0; i < count; i++) {
                    const angle = s.start + step * (i + 0.5);
                    const useAngle = normalizeAngle(angle);

                    const targetX = center.x + ringRadius * Math.cos(useAngle);
                    const targetY = center.y + ringRadius * Math.sin(useAngle);

                    const satellite = sortedSatellites[nodeIdx++];
                    if (satellite) {
                        targets.set(satellite.node.getModel().id, { x: targetX, y: targetY });
                    }
                }
            });

            // 将实体自身目标刷新为最终位置
            targets.set(model.id, { x: center.x, y: center.y });
        });

        // 双实体关系节点
        relationshipNodes.forEach(relNode => {
            const relId = relNode.getModel().id;
            const connectedEntities = relationshipConnections.get(relId);

            if (connectedEntities && connectedEntities.size === 2) {
                const [entityA, entityB] = Array.from(connectedEntities.values());
                const idA = entityA.getModel().id;
                const idB = entityB.getModel().id;
                const posA = entityPositions.get(idA);
                const posB = entityPositions.get(idB);
                if (!posA || !posB) return;

                const midX = (posA.x + posB.x) / 2;
                const midY = (posA.y + posB.y) / 2;

                const anchorPos = { x: midX, y: midY };
                targets.set(relId, anchorPos);
                relAnchors.set(relId, anchorPos);
                relRadii.set(relId, getRadius(relNode));
            }
        });

        // 同一实体对之间的多个关系菱形分布
        const groupedRelations = new Map();
        relationshipNodes.forEach(relNode => {
            const relId = relNode.getModel().id;
            const connected = relationshipConnections.get(relId);
            if (!connected || connected.size !== 2) return;
            const [entityA, entityB] = Array.from(connected.values());
            const idA = entityA.getModel().id;
            const idB = entityB.getModel().id;
            const key = idA < idB ? `${idA}__${idB}` : `${idB}__${idA}`;
            if (!groupedRelations.has(key)) groupedRelations.set(key, []);
            groupedRelations.get(key).push({
                relNode,
                relRadius: getRadius(relNode),
                entities: [entityA, entityB]
            });
        });

        groupedRelations.forEach(list => {
            if (list.length <= 1) return;
            const sample = list[0];
            const [entityA, entityB] = sample.entities;
            const idA = entityA.getModel().id;
            const idB = entityB.getModel().id;
            const posA = entityPositions.get(idA);
            const posB = entityPositions.get(idB);
            if (!posA || !posB) return;
            const dx = posB.x - posA.x;
            const dy = posB.y - posA.y;
            const dist = Math.hypot(dx, dy) || 1;
            const nx = dx / dist;
            const ny = dy / dist;
            const px = -ny;
            const py = nx;

            const baseX = targets.get(sample.relNode.getModel().id)?.x || (posA.x + posB.x) / 2;
            const baseY = targets.get(sample.relNode.getModel().id)?.y || (posA.y + posB.y) / 2;
            const maxRadius = Math.max(...list.map(item => item.relRadius));
            const offsetStep = maxRadius * 2 + 16;

            const sorted = list.slice().sort((a, b) => a.relNode.getModel().id.localeCompare(b.relNode.getModel().id));
            const mid = (sorted.length - 1) / 2;
            sorted.forEach((item, idx) => {
                const offsetIndex = idx - mid;
                const ox = px * offsetIndex * offsetStep;
                const oy = py * offsetIndex * offsetStep;
                const newPos = { x: baseX + ox, y: baseY + oy };
                const rid = item.relNode.getModel().id;
                targets.set(rid, newPos);
                relAnchors.set(rid, newPos);
            });
        });

        // 关系节点额外防重叠修正 (网格加速)
        if (relAnchors.size) {
            const relPositions = new Map();
            relAnchors.forEach((anchor, id) => {
                const t = targets.get(id);
                relPositions.set(id, t ? { ...t } : { ...anchor });
            });

            const entityCollisionRadius = new Map();
            entityNodes.forEach(en => {
                const mid = en.getModel();
                const ring = entityOrbitRadius.get(mid.id) || baseRing.get(mid.id) || 60;
                entityCollisionRadius.set(mid.id, ring + 20);
            });

            const relIdArr = [];
            relPositions.forEach((_, id) => relIdArr.push(id));
            const maxRelR = relIdArr.length
                ? Math.max(...relIdArr.map(id => relRadii.get(id) || 30))
                : 30;
            const relCellSize = Math.max(60, (maxRelR * 2) + 14);

            for (let iter = 0; iter < 80; iter++) {
                let moved = 0;

                const relItems = relIdArr.map(id => ({
                    id,
                    pos: relPositions.get(id),
                    r: relRadii.get(id) || 30
                }));
                const relGrid = buildGrid(relItems, relCellSize);

                for (let i = 0; i < relItems.length; i++) {
                    const a = relItems[i];
                    forEachNeighbor(relGrid, relCellSize, a, (b) => {
                        if (b.id <= a.id) return;
                        const dx = b.pos.x - a.pos.x;
                        const dy = b.pos.y - a.pos.y;
                        let dist = Math.hypot(dx, dy);
                        if (dist === 0) dist = 0.01;
                        const minDist = a.r + b.r + 14;
                        if (dist < minDist) {
                            const push = (minDist - dist) / 2;
                            const nx = dx / dist;
                            const ny = dy / dist;
                            a.pos.x -= nx * push;
                            a.pos.y -= ny * push;
                            b.pos.x += nx * push;
                            b.pos.y += ny * push;
                            if (push > moved) moved = push;
                        }
                    });
                }

                relPositions.forEach((pos, rid) => {
                    const relNode = graph.findById(rid);
                    const connected = relNode ? relationshipConnections.get(rid) : null;
                    if (!connected) return;

                    connected.forEach(entNode => {
                        const em = entNode.getModel();
                        const center = entityPositions.get(em.id) || { x: em.x, y: em.y };
                        const limit = entityCollisionRadius.get(em.id) || 80;
                        const dx = pos.x - center.x;
                        const dy = pos.y - center.y;
                        let dist = Math.hypot(dx, dy);
                        if (dist === 0) dist = 0.01;
                        if (dist < limit) {
                            const push = (limit - dist);
                            const nx = dx / dist;
                            const ny = dy / dist;
                            pos.x += nx * push;
                            pos.y += ny * push;
                            if (push > moved) moved = push;
                        }
                    });
                });

                relPositions.forEach((pos, id) => {
                    const anchor = relAnchors.get(id);
                    if (!anchor) return;
                    pos.x = pos.x * 0.85 + anchor.x * 0.15;
                    pos.y = pos.y * 0.85 + anchor.y * 0.15;
                });

                if (moved < 0.3) break;
            }

            relPositions.forEach((pos, id) => {
                targets.set(id, { ...pos });
            });
        }

        // 全局防重叠 (网格加速)
        const applyGlobalSeparation = () => {
            const allNodes = graph.getNodes();
            const metaArr = allNodes.map(n => ({
                id: n.getModel().id,
                r: getRadius(n)
            }));
            metaArr.forEach(m => {
                if (!targets.has(m.id)) {
                    const model = graph.findById(m.id)?.getModel();
                    targets.set(m.id, { x: model?.x || 0, y: model?.y || 0 });
                }
            });

            const maxR = metaArr.length ? Math.max(...metaArr.map(m => m.r)) : 30;
            const cellSize = Math.max(40, maxR * 2 + 8);

            for (let iter = 0; iter < 400; iter++) {
                let maxMove = 0;

                const items = metaArr.map(m => ({
                    id: m.id,
                    r: m.r,
                    pos: targets.get(m.id)
                }));
                const grid = buildGrid(items, cellSize);

                for (let i = 0; i < items.length; i++) {
                    const a = items[i];
                    forEachNeighbor(grid, cellSize, a, (b) => {
                        if (b.id <= a.id) return;
                        const dx = b.pos.x - a.pos.x;
                        const dy = b.pos.y - a.pos.y;
                        let dist = Math.hypot(dx, dy);
                        if (dist === 0) dist = 0.01;
                        const minDist = a.r + b.r + 8;
                        if (dist < minDist) {
                            const push = (minDist - dist) / 2;
                            const nx = dx / dist;
                            const ny = dy / dist;
                            a.pos.x -= nx * push;
                            a.pos.y -= ny * push;
                            b.pos.x += nx * push;
                            b.pos.y += ny * push;
                            if (push > maxMove) maxMove = push;
                        }
                    });
                }
                if (maxMove < 0.3) break;
            }
        };

        applyGlobalSeparation();

        animateNodesToTargets(graph, targets, 850, () => {
            smoothFitView(graph, 800, 'easeOutCubic');
        });
    };

    // 初始化 LayoutArrange 命名空间
    if (!exports.LayoutArrange) {
        exports.LayoutArrange = {};
    }

    // 导出函数
    Object.assign(exports.LayoutArrange, {
        arrangeLayout
    });

})(window);
