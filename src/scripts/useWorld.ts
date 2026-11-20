/**
 * SSR 安全的世界读取。
 * 服务端渲染时永远是 org，客户端挂载后才跟随真实世界 ——
 * 避免「从会话里恢复世界」导致首帧与 SSR 的 HTML 不一致。
 */
import { useEffect, useState } from 'react';
import { useStore } from '@nanostores/react';
import { $world } from './world';
import type { WorldId } from '../data/identities';

export function useWorld(): WorldId {
  const world = useStore($world);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready ? world : 'org';
}
