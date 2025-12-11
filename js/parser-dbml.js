/**
 * DBML Parser - 解析 DBML 语句
 */

const parseDBML = (dbml) => {
    const tables = [];
    const relationships = [];

    // Remove comments and normalize whitespace
    const cleanDbml = dbml
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();

    const tableRegex = /Table\s+`?([\w\u4e00-\u9fa5]+)`?(?:\s+as\s+`?([\w\u4e00-\u9fa5]+)`?)?\s*\{([\s\S]*?)\}/g;
    let tableMatch;

    while ((tableMatch = tableRegex.exec(cleanDbml)) !== null) {
        const tableName = tableMatch[1];
        const tableAlias = tableMatch[2];
        const tableBody = tableMatch[3].trim();
        const columns = [];
        const primaryKeys = [];
        const foreignKeys = [];

        tableBody.split('\n').forEach(line => {
            if (!line.trim()) return;

            // Match `column_name` type [attributes]
            const columnMatch = line.trim().match(/^`?([\w\u4e00-\u9fa5]+)`?\s+([\w\d\(\)\s,]+)(?:\s*\[([^\]]*)\])?/);

            if (columnMatch) {
                const columnName = columnMatch[1];
                const columnType = columnMatch[2].trim();
                const attributesStr = columnMatch[3] || '';

                const isPrimaryKey = attributesStr.includes('pk') || attributesStr.includes('primary key');

                if (isPrimaryKey) {
                    primaryKeys.push(columnName);
                }

                // Handle inline references
                const refMatch = attributesStr.match(/ref:\s*(?:[-><])\s*`?([\w\u4e00-\u9fa5]+)`?\.`?([\w\u4e00-\u9fa5]+)`?/);
                if (refMatch) {
                    const toTable = refMatch[1];
                    const toColumn = refMatch[2];

                    relationships.push({
                        from: tableName,
                        to: toTable,
                        label: columnName
                    });

                    foreignKeys.push({
                        column: columnName,
                        referencedTable: toTable,
                        referencedColumn: toColumn
                    });
                }

                columns.push({
                    name: columnName,
                    type: columnType,
                    isPrimaryKey: isPrimaryKey
                });
            }
        });

        tables.push({
            name: tableName,
            alias: tableAlias,
            columns,
            primaryKeys,
            foreignKeys: foreignKeys
        });
    }

    // 支持中文表名和列名的 Ref 语句
    const refRegex = /Ref\s*:\s*`?([\w\u4e00-\u9fa5]+)`?\.`?([\w\u4e00-\u9fa5]+)`?\s*[-><]\s*`?([\w\u4e00-\u9fa5]+)`?\.`?([\w\u4e00-\u9fa5]+)`?/g;
    let refMatch;

    while ((refMatch = refRegex.exec(cleanDbml)) !== null) {
        const fromTable = refMatch[1];
        const fromColumn = refMatch[2];
        const toTable = refMatch[3];
        const toColumn = refMatch[4];

        relationships.push({
            from: fromTable,
            to: toTable,
            label: fromColumn
        });

        const table = tables.find(t => t.name === fromTable);
        if (table) {
            if (!table.foreignKeys) {
                table.foreignKeys = [];
            }
            table.foreignKeys.push({
                column: fromColumn,
                referencedTable: toTable,
                referencedColumn: toColumn
            });
        }
    }

    return { tables, relationships };
};
