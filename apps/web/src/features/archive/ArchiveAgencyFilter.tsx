"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GrantArchiveFacetOption } from "@/lib/server/archive/grantArchiveSearch";

interface ArchiveAgencyFilterProps {
  initialOptions: GrantArchiveFacetOption[];
  selected: string[];
}

interface AgencyOption {
  value: string;
  label: string;
  count: number;
}

const FETCH_LIMIT = 20;
const DEBOUNCE_MS = 250;

/**
 * 주관기관(agencyPrimary) 다중 선택 필터.
 * 부모 GET 폼(`<form action="/archive" method="get">`)에 name="agency" hidden input으로 편입되어,
 * 기존 "적용" 버튼 제출 흐름을 그대로 탄다. 첫 페인트는 서버가 넘긴 facets.agencies로 채우고,
 * 타이핑 시에만 /api/web/archive/agencies 자동완성을 250ms 디바운스로 호출한다.
 */
export function ArchiveAgencyFilter({ initialOptions, selected }: ArchiveAgencyFilterProps) {
  const baseOptions = useMemo<AgencyOption[]>(
    () => initialOptions.map((option) => ({ value: option.value, label: option.label, count: option.count })),
    [initialOptions],
  );

  const [selectedValues, setSelectedValues] = useState<string[]>(() => dedupe(selected));
  const [labels, setLabels] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const option of initialOptions) map[option.value] = option.label;
    for (const value of selected) if (!(value in map)) map[value] = value;
    return map;
  });
  const [queryText, setQueryText] = useState("");
  const [options, setOptions] = useState<AgencyOption[]>(baseOptions);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();
  const optionIdBase = useId();

  const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues]);

  // 외부 클릭 시 드롭다운 닫기
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // 타이핑 자동완성(250ms 디바운스). 입력이 비면 서버가 넘긴 상위 목록으로 되돌린다.
  useEffect(() => {
    const term = queryText.trim();
    if (!term) {
      setOptions(baseOptions);
      setLoading(false);
      return;
    }

    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: term, limit: String(FETCH_LIMIT) });
      fetch(`/api/web/archive/agencies?${params.toString()}`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      })
        .then((response) => response.json())
        .then((payload: unknown) => {
          const next = extractOptions(payload);
          if (!next) throw new Error("agency autocomplete rejected");
          setLabels((current) => {
            const merged = { ...current };
            for (const option of next) merged[option.value] = option.label;
            return merged;
          });
          setOptions(next);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          // 조용한 폴백: 서버가 넘긴 상위 목록을 클라이언트에서 부분 매칭
          console.error("주관기관 자동완성 요청 실패", error);
          const lowered = term.toLowerCase();
          setOptions(baseOptions.filter((option) => option.label.toLowerCase().includes(lowered)));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [queryText, baseOptions]);

  // 목록이 바뀌거나 열림 상태가 바뀌면 하이라이트를 초기화
  useEffect(() => {
    setActiveIndex(-1);
  }, [options, open]);

  const toggleValue = useCallback((value: string, label?: string) => {
    setSelectedValues((current) =>
      current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value],
    );
    if (label) {
      setLabels((current) => (current[value] ? current : { ...current, [value]: label }));
    }
  }, []);

  const removeValue = useCallback((value: string) => {
    setSelectedValues((current) => current.filter((entry) => entry !== value));
  }, []);

  const commitOption = useCallback(
    (option: AgencyOption) => {
      toggleValue(option.value, option.label);
      setQueryText("");
      inputRef.current?.focus();
    },
    [toggleValue],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        setActiveIndex((index) => Math.min(index + 1, options.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        setActiveIndex((index) => Math.max(index - 1, 0));
      } else if (event.key === "Enter") {
        if (open && activeIndex >= 0 && activeIndex < options.length) {
          // 항목 선택 시 폼이 제출되지 않도록 막는다
          event.preventDefault();
          commitOption(options[activeIndex]!);
        }
      } else if (event.key === "Escape") {
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
      }
    },
    [activeIndex, commitOption, open, options],
  );

  return (
    <div ref={containerRef} className="grid gap-2">
      {selectedValues.map((value) => (
        <input key={value} type="hidden" name="agency" value={value} />
      ))}

      {selectedValues.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="선택한 주관기관">
          {selectedValues.map((value) => (
            <li key={value}>
              <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-muted py-1 pl-2 pr-1 text-xs font-medium text-foreground">
                <span className="max-w-[11rem] truncate">{labels[value] ?? value}</span>
                <button
                  type="button"
                  className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                  aria-label={`${labels[value] ?? value} 제거`}
                  onClick={() => removeValue(value)}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && activeIndex >= 0 ? `${optionIdBase}-${activeIndex}` : undefined}
          aria-label="주관기관 검색"
          className="h-9 w-full rounded-[var(--radius-lg)] border bg-input py-2 pl-9 pr-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15"
          type="text"
          autoComplete="off"
          value={queryText}
          placeholder="주관기관 검색"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQueryText(event.currentTarget.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />

        {open ? (
          <div className="absolute inset-x-0 top-[calc(100%+0.25rem)] z-50 overflow-hidden rounded-[var(--radius-lg)] border bg-popover text-popover-foreground shadow-[var(--shadow-subtle)]">
            <ul
              id={listboxId}
              role="listbox"
              aria-label="주관기관 목록"
              className="max-h-64 overflow-y-auto p-1"
            >
              {options.length === 0 ? (
                <li className="px-2 py-2 text-xs text-muted-foreground">
                  {loading ? "검색 중…" : "일치하는 주관기관이 없습니다."}
                </li>
              ) : (
                options.map((option, index) => {
                  const active = index === activeIndex;
                  const chosen = selectedSet.has(option.value);
                  return (
                    <li
                      key={option.value}
                      id={`${optionIdBase}-${index}`}
                      role="option"
                      aria-selected={chosen}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-sm outline-none",
                        active && "bg-accent text-accent-foreground",
                      )}
                      onMouseEnter={() => setActiveIndex(index)}
                      onPointerDown={(event) => {
                        // 클릭으로 인한 input blur → 드롭다운 닫힘을 막고 선택을 유지
                        event.preventDefault();
                      }}
                      onClick={() => commitOption(option)}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center text-primary">
                        {chosen ? <Check className="size-3.5" aria-hidden /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {option.count.toLocaleString("ko-KR")}
                      </span>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function extractOptions(payload: unknown): AgencyOption[] | null {
  if (!payload || typeof payload !== "object") return null;
  const result = payload as { ok?: unknown; data?: { options?: unknown } };
  if (result.ok !== true) return null;
  const rawOptions = result.data?.options;
  if (!Array.isArray(rawOptions)) return null;
  const options: AgencyOption[] = [];
  for (const entry of rawOptions) {
    if (!entry || typeof entry !== "object") continue;
    const option = entry as { value?: unknown; label?: unknown; count?: unknown };
    if (typeof option.value !== "string") continue;
    options.push({
      value: option.value,
      label: typeof option.label === "string" ? option.label : option.value,
      count: typeof option.count === "number" ? option.count : 0,
    });
  }
  return options;
}
