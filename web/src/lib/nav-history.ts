// 应用内导航面包屑：用 sessionStorage 存一份最近访问路由（pathname + search）的小栈。
// AppShell 在每次客户端路由变化时压入当前路由；report-view 读取它来判断“返回”按钮
// 应该回到进入详情页之前的哪个页面，而不是硬编码回到管道列表页。
//
// 只在客户端执行（读写 sessionStorage），无 SSR 影响。

const KEY = "co-nav-history";
const MAX = 12;

/** 读取历史栈，容错（损坏/缺失按空栈处理） */
function readStack(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 记录当前路由。与栈顶去重：同路由的重复渲染（如仅 search 变化）不污染栈。 */
export function pushNavHistory(route: string): void {
  const stack = readStack();
  if (stack[stack.length - 1] === route) return;
  stack.push(route);
  if (stack.length > MAX) stack.splice(0, stack.length - MAX);
  try {
    sessionStorage.setItem(KEY, JSON.stringify(stack));
  } catch {
    /* sessionStorage 不可用 → 尽力而为，返回按钮退化为回管道列表 */
  }
}

/** 当前页之前的那个路由；当当前页是首个应用内入口（直接打开/新标签页）时返回 null。 */
export function prevNavHistory(): string | null {
  const stack = readStack();
  return stack.length >= 2 ? stack[stack.length - 2] : null;
}