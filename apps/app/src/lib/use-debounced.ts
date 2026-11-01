// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';

// `value` once it has stayed the same for `ms`: a search box asks the server per pause in typing, not per key.
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
