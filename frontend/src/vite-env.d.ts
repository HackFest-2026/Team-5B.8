/// <reference types="vite/client" />

/**
 * CSS Modules. Without this declaration, `import s from './X.module.css'` is a
 * type error under `strict`, and the class names would be untyped anyway.
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

/** Only the variables this app actually reads. */
interface ImportMetaEnv {
  readonly VITE_API_BASE: string;
  readonly VITE_WS_BASE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
