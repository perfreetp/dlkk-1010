declare module 'sql.js' {
  interface SqlJsStatic {
    Database: new (data?: Buffer | Uint8Array) => Database;
  }

  interface Statement {
    bind(params: any[]): boolean;
    step(): boolean;
    getAsObject(): any;
    get(params?: any[]): any[];
    getColumnNames(): string[];
    run(): void;
    reset(): void;
    free(): boolean;
  }

  interface Database {
    run(sql: string, params?: any[]): Database;
    exec(sql: string, params?: any[]): Array<{ columns: string[]; values: any[][] }>;
    each(sql: string, params: any[], callback: (row: any) => void, done: () => void): Database;
    prepare(sql: string, params?: any[]): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
    lastInsertRowid(): number;
    changes(): number;
    last_insert_rowid(): number;
  }

  interface InitSqlJsOptions {
    locateFile?: (filename: string) => string;
  }

  function initSqlJs(options?: InitSqlJsOptions): Promise<SqlJsStatic>;
  export = initSqlJs;
}
