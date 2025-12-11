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

        // 弹簧迭代 + 碰撞检测
        const safeGap = 50;
        const entityIds = Array.from(entityPositions.keys());

        for (let iter = 0; iter < 300; iter++) {
            let maxMove = 0;

            // 1. 吸引力：通过关系连接的实体
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

                const rA = systemRadius.get(idA);
                const rB = systemRadius.get(idB);
                const desired = rA + rB + safeGap;

                const diff = desired - dist;
                if (Math.abs(diff) < 1) return;

                const nx = dx / dist;
                const ny = dy / dist;
                const move = (diff * 0.2) / 2;

                posA.x -= nx * move;
                posA.y -= ny * move;
                posB.x += nx * move;
                posB.y += ny * move;
                maxMove = Math.max(maxMove, Math.abs(move));
            });

            // 2. 全局斥力：防止任意两个实体重叠
            for (let i = 0; i < entityIds.length; i++) {
                for (let j = i + 1; j < entityIds.length; j++) {
                    const idA = entityIds[i];
                    const idB = entityIds[j];
                    const posA = entityPositions.get(idA);
                    const posB = entityPositions.get(idB);

                    const dx = posB.x - posA.x;
                    const dy = posB.y - posA.y;
                    const dist = Math.hypot(dx, dy) || 1;

                    const rA = systemRadius.get(idA);
                    const rB = systemRadius.get(idB);
                    const minDesc = rA + rB + safeGap;

                    if (dist < minDesc) {
                        const overlap = minDesc - dist;
                        const nx = dx / dist;
                        const ny = dy / dist;
                        const move = overlap * 0.5 * 0.5;

                        posA.x -= nx * move;
                        posA.y -= ny * move;
                        posB.x += nx * move;
                        posB.y += ny * move;
                        maxMove = Math.max(maxMove, move);
                    }
                }
            }

            if (maxMove < 0.5) break;
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

        // 关系节点额外防重叠修正
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

            for (let iter = 0; iter < 80; iter++) {
                relationshipNodes.forEach((relA, idxA) => {
                    const idA = relA.getModel().id;
                    const posA = relPositions.get(idA);
                    const rA = relRadii.get(idA) || 30;
                    if (!posA) return;

                    for (let j = idxA + 1; j < relationshipNodes.length; j++) {
                        const relB = relationshipNodes[j];
                        const idB = relB.getModel().id;
                        const posB = relPositions.get(idB);
                        const rB = relRadii.get(idB) || 30;
                        if (!posB) continue;

                        const dx = posB.x - posA.x;
                        const dy = posB.y - posA.y;
                        let dist = Math.hypot(dx, dy);
                        if (dist === 0) dist = 0.01;
                        const minDist = rA + rB + 14;
                        if (dist < minDist) {
                            const push = (minDist - dist) / 2;
                            const nx = dx / dist;
                            const ny = dy / dist;
                            posA.x -= nx * push;
                            posA.y -= ny * push;
                            posB.x += nx * push;
                            posB.y += ny * push;
                        }
                    }
                });

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
                        }
                    });
                });

                relPositions.forEach((pos, id) => {
                    const anchor = relAnchors.get(id);
                    if (!anchor) return;
                    pos.x = pos.x * 0.85 + anchor.x * 0.15;
                    pos.y = pos.y * 0.85 + anchor.y * 0.15;
                });
            }

            relPositions.forEach((pos, id) => {
                targets.set(id, { ...pos });
            });
        }

        // 全局防重叠
        const applyGlobalSeparation = () => {
            const allNodes = graph.getNodes();
            const meta = allNodes.map(n => ({
                id: n.getModel().id,
                r: getRadius(n)
            }));
            meta.forEach(m => {
                if (!targets.has(m.id)) {
                    const model = graph.findById(m.id)?.getModel();
                    targets.set(m.id, { x: model?.x || 0, y: model?.y || 0 });
                }
            });

            for (let iter = 0; iter < 400; iter++) {
                let maxMove = 0;
                for (let i = 0; i < meta.length; i++) {
                    for (let j = i + 1; j < meta.length; j++) {
                        const a = meta[i], b = meta[j];
                        const pa = targets.get(a.id);
                        const pb = targets.get(b.id);
                        if (!pa || !pb) continue;
                        const dx = pb.x - pa.x;
                        const dy = pb.y - pa.y;
                        let dist = Math.hypot(dx, dy);
                        if (dist === 0) dist = 0.01;
                        const minDist = a.r + b.r + 8;
                        if (dist < minDist) {
                            const push = (minDist - dist) / 2;
                            const nx = dx / dist;
                            const ny = dy / dist;
                            pa.x -= nx * push;
                            pa.y -= ny * push;
                            pb.x += nx * push;
                            pb.y += ny * push;
                            maxMove = Math.max(maxMove, push);
                        }
                    }
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
