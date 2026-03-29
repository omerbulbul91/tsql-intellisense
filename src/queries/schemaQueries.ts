/** Raw SQL queries for fetching database schema metadata */

/** All tables and views */
export const ALL_OBJECTS_QUERY = `
SELECT TABLE_NAME, TABLE_TYPE
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'dbo'
ORDER BY TABLE_NAME;
`;

/** All stored procedures and functions */
export const ALL_ROUTINES_QUERY = `
SELECT ROUTINE_NAME, ROUTINE_TYPE
FROM INFORMATION_SCHEMA.ROUTINES
WHERE ROUTINE_SCHEMA = 'dbo'
ORDER BY ROUTINE_NAME;
`;

/** All columns (bulk load) */
export const ALL_COLUMNS_QUERY = `
SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE,
       c.CHARACTER_MAXIMUM_LENGTH, c.ORDINAL_POSITION,
       c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.DATETIME_PRECISION,
       COLUMNPROPERTY(OBJECT_ID('dbo.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY,
       CASE WHEN c.COLUMN_DEFAULT IS NOT NULL THEN 1 ELSE 0 END AS HAS_DEFAULT,
       c.COLUMN_DEFAULT,
       dc.name AS DEFAULT_CONSTRAINT_NAME,
       cc.definition AS COMPUTED_DEFINITION,
       cc.is_persisted AS IS_PERSISTED
FROM INFORMATION_SCHEMA.COLUMNS c
LEFT JOIN sys.columns sc ON sc.object_id = OBJECT_ID('dbo.' + c.TABLE_NAME) AND sc.name = c.COLUMN_NAME
LEFT JOIN sys.default_constraints dc ON sc.default_object_id = dc.object_id
LEFT JOIN sys.computed_columns cc ON sc.object_id = cc.object_id AND sc.column_id = cc.column_id
WHERE c.TABLE_SCHEMA = 'dbo'
ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION;
`;

/** Columns for a specific table/view */
export const TABLE_COLUMNS_QUERY = `
SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE,
       c.CHARACTER_MAXIMUM_LENGTH, c.ORDINAL_POSITION,
       c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.DATETIME_PRECISION,
       COLUMNPROPERTY(OBJECT_ID('dbo.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY,
       CASE WHEN c.COLUMN_DEFAULT IS NOT NULL THEN 1 ELSE 0 END AS HAS_DEFAULT,
       c.COLUMN_DEFAULT,
       dc.name AS DEFAULT_CONSTRAINT_NAME,
       cc.definition AS COMPUTED_DEFINITION,
       cc.is_persisted AS IS_PERSISTED
FROM INFORMATION_SCHEMA.COLUMNS c
LEFT JOIN sys.columns sc ON sc.object_id = OBJECT_ID('dbo.' + c.TABLE_NAME) AND sc.name = c.COLUMN_NAME
LEFT JOIN sys.default_constraints dc ON sc.default_object_id = dc.object_id
LEFT JOIN sys.computed_columns cc ON sc.object_id = cc.object_id AND sc.column_id = cc.column_id
WHERE c.TABLE_SCHEMA = 'dbo' AND c.TABLE_NAME = @tableName
ORDER BY c.ORDINAL_POSITION;
`;

/** SP/Function definition */
export const OBJECT_DEFINITION_QUERY = `
SELECT OBJECT_DEFINITION(OBJECT_ID(@objectName)) AS [definition];
`;

/** All view definitions */
export const ALL_VIEW_DEFINITIONS_QUERY = `
SELECT
    t.TABLE_NAME,
    OBJECT_DEFINITION(OBJECT_ID(t.TABLE_SCHEMA + '.' + t.TABLE_NAME)) AS VIEW_DEFINITION
FROM INFORMATION_SCHEMA.TABLES t
WHERE t.TABLE_SCHEMA = 'dbo' AND t.TABLE_TYPE = 'VIEW'
ORDER BY t.TABLE_NAME;
`;

/** Triggers per table */
export const ALL_TRIGGERS_QUERY = `
SELECT
    t.name AS TRIGGER_NAME,
    OBJECT_NAME(t.parent_id) AS TABLE_NAME,
    OBJECT_DEFINITION(t.object_id) AS TRIGGER_DEFINITION
FROM sys.triggers t
WHERE t.parent_class = 1
ORDER BY TABLE_NAME, t.name;
`;

/** Foreign key relationships */
export const FK_QUERY = `
SELECT
    fk.name AS FK_NAME,
    tp.name AS PARENT_TABLE,
    cp.name AS PARENT_COLUMN,
    tr.name AS REFERENCED_TABLE,
    cr.name AS REFERENCED_COLUMN,
    fk.delete_referential_action_desc AS DELETE_ACTION,
    fk.update_referential_action_desc AS UPDATE_ACTION
FROM sys.foreign_keys fk
INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
INNER JOIN sys.tables tp ON fkc.parent_object_id = tp.object_id
INNER JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
INNER JOIN sys.tables tr ON fkc.referenced_object_id = tr.object_id
INNER JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
ORDER BY fk.name;
`;

/** All indexes and primary keys per table */
export const ALL_INDEXES_QUERY = `
SELECT
    OBJECT_NAME(i.object_id) AS TABLE_NAME,
    i.name AS INDEX_NAME,
    i.type_desc AS INDEX_TYPE,
    i.is_unique AS IS_UNIQUE,
    i.is_primary_key AS IS_PRIMARY_KEY,
    STRING_AGG('[' + c.name + ']' + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE ' ASC' END, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS COLUMNS,
    i.filter_definition AS FILTER_DEFINITION
FROM sys.indexes i
INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id AND ic.is_included_column = 0
INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
INNER JOIN sys.tables t ON i.object_id = t.object_id
WHERE t.schema_id = SCHEMA_ID('dbo') AND i.name IS NOT NULL
GROUP BY i.object_id, i.name, i.type_desc, i.is_unique, i.is_primary_key, i.filter_definition, i.index_id
ORDER BY TABLE_NAME, i.is_primary_key DESC, i.index_id;
`;

/** SP parameters */
export const SP_PARAMETERS_QUERY = `
SELECT PARAMETER_NAME, DATA_TYPE, PARAMETER_MODE, CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.PARAMETERS
WHERE SPECIFIC_SCHEMA = 'dbo' AND SPECIFIC_NAME = @spName
ORDER BY ORDINAL_POSITION;
`;
