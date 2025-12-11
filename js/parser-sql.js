/**
 * SQL Parser - 解析 CREATE TABLE 语句
 */

const parseSQLTables = (sql) => {
    const tables = [];
    const relationships = [];

    // Remove comments and normalize whitespace
    const cleanSql = sql
        .replace(/--.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();

    // Split SQL into individual statements. This is more robust.
    const statements = cleanSql.split(';').filter(s => s.trim());

    statements.forEach(statement => {
        // We only care about CREATE TABLE statements
        const createTableMatch = statement.match(/^\s*CREATE\s+TABLE/i);
        if (!createTableMatch) {
            return;
        }

        // Extract table name
        const tableNameMatch = statement.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\`?([\w\u4e00-\u9fa5]+)\`?/i);
        if (!tableNameMatch) return;

        const tableName = tableNameMatch[1];

        // Manually find the content within the main parentheses to avoid complex regex
        const openParenIndex = statement.indexOf('(');
        if (openParenIndex === -1) return;

        let closeParenIndex = -1;
        let parenDepth = 0;
        for (let i = openParenIndex + 1; i < statement.length; i++) {
            const char = statement[i];
            if (char === '(') {
                parenDepth++;
            } else if (char === ')') {
                if (parenDepth === 0) {
                    closeParenIndex = i;
                    break;
                }
                parenDepth--;
            }
        }

        if (closeParenIndex === -1) {
            return; // Malformed CREATE TABLE statement
        }

        const tableBody = statement.substring(openParenIndex + 1, closeParenIndex);

        const columns = [];
        const primaryKeys = [];
        const foreignKeys = [];

        // Split by commas, but be careful with nested parentheses for types like DECIMAL(10, 2)
        const parts = [];
        let currentPart = '';
        let depth = 0;

        for (let i = 0; i < tableBody.length; i++) {
            const char = tableBody[i];
            if (char === '(') depth++;
            else if (char === ')') depth--;
            else if (char === ',' && depth === 0) {
                parts.push(currentPart.trim());
                currentPart = '';
                continue;
            }
            currentPart += char;
        }
        if (currentPart.trim()) parts.push(currentPart.trim());

        parts.forEach(part => {
            const trimmedPart = part.trim().replace(/,\s*$/, ''); // Clean trailing commas
            if (!trimmedPart) return;

            // Check for PRIMARY KEY constraint at the table level
            if (/^PRIMARY\s+KEY\s*\((.*)\)/i.test(trimmedPart)) {
                const pkMatch = trimmedPart.match(/^PRIMARY\s+KEY\s*\((.*)\)/i);
                if (pkMatch) {
                    const pkColumns = pkMatch[1].split(',').map(col => col.trim().replace(/[`"']/g, ''));
                    primaryKeys.push(...pkColumns);
                }
            }
            // Check for FOREIGN KEY constraint
            else if (/^(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY/i.test(trimmedPart)) {
                const fkMatch = trimmedPart.match(/^(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\s*\(\s*\`?([\w\u4e00-\u9fa5]+)\`?\s*\)\s+REFERENCES\s+\`?([\w\u4e00-\u9fa5]+)\`?\s*\(\s*\`?([\w\u4e00-\u9fa5]+)\`?\s*\)/i);
                if (fkMatch) {
                    foreignKeys.push({
                        column: fkMatch[1],
                        referencedTable: fkMatch[2],
                        referencedColumn: fkMatch[3]
                    });
                }
            }
            // Regular column definition
            else if (/^(\`?[\w\u4e00-\u9fa5]+\`?)\s+/.test(trimmedPart)) {
                const columnMatch = trimmedPart.match(/^(\`?[\w\u4e00-\u9fa5]+\`?)\s+(\w+(?:\(\d+(?:,\s*\d+)?\))?)(.*)/i);
                if (columnMatch) {
                    const columnName = columnMatch[1].replace(/`/g, '');
                    const dataType = columnMatch[2];
                    const constraints = columnMatch[3] || '';

                    const isPrimaryKey = /PRIMARY\s+KEY/i.test(constraints);
                    if (isPrimaryKey) {
                        primaryKeys.push(columnName);
                    }

                    columns.push({
                        name: columnName,
                        type: dataType,
                        isPrimaryKey
                    });
                }
            }
        });

        tables.push({
            name: tableName,
            columns,
            primaryKeys,
            foreignKeys
        });

        // Add relationships
        foreignKeys.forEach(fk => {
            relationships.push({
                from: tableName,
                to: fk.referencedTable,
                label: fk.column
            });
        });
    });

    return { tables, relationships };
};
