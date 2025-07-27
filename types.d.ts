// 类型声明文件 - 处理缺失的模块类型

declare module 'spawn-rx' {
  export function findActualExecutable(command: string): string;
}

declare module '@statsig/js-client' {
  export interface StatsigUser {
    userID?: string;
    email?: string;
    ip?: string;
    userAgent?: string;
    country?: string;
    locale?: string;
    appVersion?: string;
    [key: string]: any;
  }
}

declare module 'ansi-escapes' {
  export const cursorShow: string;
  export const cursorHide: string;
  export const eraseLines: (count: number) => string;
  export const eraseDown: string;
  export const eraseUp: string;
  export const eraseScreen: string;
  export const scrollUp: string;
  export const scrollDown: string;
  export const beep: string;
  export const link: (text: string, url: string) => string;
  export const image: (buffer: Buffer, options?: any) => string;
  export const iTerm: {
    setCwd: (cwd: string) => string;
    annotation: (message: string, options?: any) => string;
  };
}

declare module 'figures' {
  const figures: {
    tick: string;
    cross: string;
    star: string;
    square: string;
    squareSmall: string;
    squareSmallFilled: string;
    play: string;
    circle: string;
    circleFilled: string;
    circleDotted: string;
    circleDouble: string;
    circleCircle: string;
    circleCross: string;
    circlePipe: string;
    circleQuestionMark: string;
    bullet: string;
    dot: string;
    line: string;
    ellipsis: string;
    pointer: string;
    pointerSmall: string;
    info: string;
    warning: string;
    hamburger: string;
    smiley: string;
    mustache: string;
    heart: string;
    nodejs: string;
    arrowUp: string;
    arrowDown: string;
    arrowLeft: string;
    arrowRight: string;
    arrowLeftRight: string;
    arrowUpDown: string;
    almostEqual: string;
    notEqual: string;
    lessOrEqual: string;
    greaterOrEqual: string;
    identical: string;
    infinity: string;
    subscriptZero: string;
    subscriptOne: string;
    subscriptTwo: string;
    subscriptThree: string;
    subscriptFour: string;
    subscriptFive: string;
    subscriptSix: string;
    subscriptSeven: string;
    subscriptEight: string;
    subscriptNine: string;
    oneHalf: string;
    oneThird: string;
    oneQuarter: string;
    oneFifth: string;
    oneSixth: string;
    oneEighth: string;
    twoThirds: string;
    twoFifths: string;
    threeQuarters: string;
    threeFifths: string;
    threeEighths: string;
    fourFifths: string;
    fiveSixths: string;
    fiveEighths: string;
    sevenEighths: string;
  };
  export default figures;
}

declare module '@inkjs/ui' {
  import { ComponentType } from 'react';
  
  export interface SelectProps {
    options: Array<{ label: string; value: string }>;
    onChange: (value: string) => void;
    value?: string;
    placeholder?: string;
  }
  
  export const Select: ComponentType<SelectProps>;
  
  export interface OrderedListProps {
    items: string[];
  }
  
  export const OrderedList: ComponentType<OrderedListProps>;
}

declare module 'highlight.js' {
  export function highlight(code: string, language: string): { value: string };
  export function highlightAuto(code: string): { value: string; language: string };
}

declare module 'env-paths' {
  interface Paths {
    data: string;
    config: string;
    cache: string;
    log: string;
    temp: string;
  }
  
  function envPaths(name: string): Paths;
  export default envPaths;
}

declare module 'marked' {
  export interface Token {
    type: string;
    text: string;
    tokens?: Token[];
    [key: string]: any;
  }
  
  export function marked(text: string): string;
  export function marked(text: string, options?: any): string;
  export function marked(text: string, callback?: (error: any, parseResult: string) => void): void;
}

declare module 'cli-highlight' {
  export function highlight(code: string, options?: any): string;
  export function supportsLanguage(language: string): boolean;
}

declare module 'wrap-ansi' {
  function wrapAnsi(input: string, columns: number, options?: any): string;
  export default wrapAnsi;
}

declare module 'diff' {
  export interface Hunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }
  
  export function structuredPatch(oldFileName: string, newFileName: string, oldStr: string, newStr: string): {
    hunks: Hunk[];
  };
}

declare module 'glob' {
  export function glob(pattern: string, options?: any): Promise<string[]>;
  export function globSync(pattern: string, options?: any): string[];
}

declare module 'lru-cache' {
  export class LRUCache<K, V> {
    constructor(options?: any);
    get(key: K): V | undefined;
    set(key: K, value: V): void;
    has(key: K): boolean;
    delete(key: K): boolean;
    clear(): void;
  }
}

declare module 'shell-quote' {
  export function parse(input: string): any[];
  export function stringify(args: any[]): string;
  export type ParseEntry = string | { op: string } | { comment: string };
  export type ControlOperator = '|' | '||' | ';' | '&' | '&&' | '>' | '<' | '>>' | '<<';
}

// 全局 MACRO 对象声明
declare global {
  const MACRO: {
    VERSION: string;
    PACKAGE_URL: string;
    README_URL: string;
    [key: string]: any;
  };
} 