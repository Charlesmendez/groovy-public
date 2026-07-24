"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";

export type SelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

type MenuPosition = {
  bottom?: number;
  left: number;
  maxHeight: number;
  top?: number;
  width: number;
};

const triggerSizes = {
  xs: "min-h-7 rounded-md px-2 py-1.5 text-[10px]",
  sm: "min-h-9 rounded-lg px-3 py-2 text-xs",
  md: "min-h-10 rounded-xl px-3.5 py-2.5 text-sm",
  lg: "min-h-12 rounded-xl px-4 py-3 text-sm",
} as const;

export function CustomSelect({
  options,
  value,
  onChange,
  placeholder = "Select…",
  className = "",
  triggerClassName = "",
  ariaLabel,
  disabled = false,
  size = "md",
}: {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  triggerClassName?: string;
  ariaLabel?: string;
  disabled?: boolean;
  size?: keyof typeof triggerSizes;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  );
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;

  const firstEnabledIndex = useCallback(
    () => options.findIndex((option) => !option.disabled),
    [options],
  );
  const lastEnabledIndex = useCallback(() => {
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (!options[index]?.disabled) return index;
    }
    return -1;
  }, [options]);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 10;
    const gap = 7;
    const desiredWidth = Math.max(180, rect.width);
    const width = Math.min(desiredWidth, viewportWidth - margin * 2);
    const left = Math.max(
      margin,
      Math.min(rect.left, viewportWidth - width - margin),
    );
    const roomBelow = viewportHeight - rect.bottom - gap - margin;
    const roomAbove = rect.top - gap - margin;
    const openUpward = roomBelow < 180 && roomAbove > roomBelow;
    const maxHeight = Math.max(
      112,
      Math.min(300, openUpward ? roomAbove : roomBelow),
    );

    setMenuPosition(
      openUpward
        ? {
            bottom: viewportHeight - rect.top + gap,
            left,
            maxHeight,
            width,
          }
        : {
            left,
            maxHeight,
            top: rect.bottom + gap,
            width,
          },
    );
  }, []);

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    setMenuPosition(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const openMenu = useCallback(() => {
    if (disabled || options.length === 0) return;
    const selectedIsEnabled =
      selectedIndex >= 0 && !options[selectedIndex]?.disabled;
    setActiveIndex(
      selectedIsEnabled ? selectedIndex : firstEnabledIndex(),
    );
    updateMenuPosition();
    setOpen(true);
  }, [
    disabled,
    firstEnabledIndex,
    options,
    selectedIndex,
    updateMenuPosition,
  ]);

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      if (options.length === 0) return;
      setActiveIndex((current) => {
        let next =
          current >= 0
            ? current
            : direction === 1
              ? -1
              : options.length;
        for (let attempts = 0; attempts < options.length; attempts += 1) {
          next = (next + direction + options.length) % options.length;
          if (!options[next]?.disabled) return next;
        }
        return current;
      });
    },
    [options],
  );

  const chooseOption = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      onChange(option.value);
      closeMenu(true);
    },
    [closeMenu, onChange, options],
  );

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement | HTMLDivElement>,
  ) => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
      } else {
        moveActive(event.key === "ArrowDown" ? 1 : -1);
      }
      return;
    }
    if (event.key === "Home" && open) {
      event.preventDefault();
      setActiveIndex(firstEnabledIndex());
      return;
    }
    if (event.key === "End" && open) {
      event.preventDefault();
      setActiveIndex(lastEnabledIndex());
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) openMenu();
      else if (activeIndex >= 0) chooseOption(activeIndex);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab" && open) closeMenu();
  };

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        closeMenu();
      }
    };
    const handleLayoutChange = () => updateMenuPosition();
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleLayoutChange);
    window.addEventListener("scroll", handleLayoutChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleLayoutChange);
      window.removeEventListener("scroll", handleLayoutChange, true);
    };
  }, [closeMenu, open, updateMenuPosition]);

  useEffect(() => {
    if (!disabled || !open) return;
    const frame = window.requestAnimationFrame(() => closeMenu());
    return () => window.cancelAnimationFrame(frame);
  }, [closeMenu, disabled, open]);

  const menu =
    open && menuPosition && typeof document !== "undefined"
      ? createPortal(
          <motion.div
            ref={menuRef}
            id={menuId}
            role="listbox"
            aria-label={ariaLabel}
            aria-activedescendant={
              activeIndex >= 0 ? `${menuId}-option-${activeIndex}` : undefined
            }
            tabIndex={-1}
            initial={{ opacity: 0, y: -5, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            onKeyDown={handleKeyDown}
            className="fixed z-[1000] overflow-hidden rounded-xl border border-white/10 bg-[#111319]/98 p-1.5 shadow-2xl shadow-black/70 backdrop-blur-xl"
            style={{
              bottom: menuPosition.bottom,
              left: menuPosition.left,
              top: menuPosition.top,
              width: menuPosition.width,
            }}
          >
            <div
              className="overflow-y-auto overscroll-contain"
              style={{ maxHeight: menuPosition.maxHeight }}
            >
              {options.map((option, index) => {
                const selected = option.value === value;
                const active = index === activeIndex;
                return (
                  <button
                    key={`${option.value}-${index}`}
                    id={`${menuId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={option.disabled}
                    onPointerMove={() => {
                      if (!option.disabled) setActiveIndex(index);
                    }}
                    onFocus={() => {
                      if (!option.disabled) setActiveIndex(index);
                    }}
                    onClick={() => chooseOption(index)}
                    className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                      selected
                        ? "bg-cyan-400/10 text-cyan-100"
                        : active
                          ? "bg-white/[0.07] text-white"
                          : "text-zinc-300 hover:bg-white/[0.05] hover:text-white"
                    } disabled:cursor-not-allowed disabled:opacity-35`}
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        selected
                          ? "border-cyan-300/40 bg-cyan-400/15"
                          : "border-white/10 bg-black/20"
                      }`}
                    >
                      {selected ? (
                        <Check className="h-3 w-3 text-cyan-300" />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.label}</span>
                      {option.description ? (
                        <span className="mt-0.5 block text-[10px] leading-relaxed text-zinc-500">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </motion.div>,
          document.body,
        )
      : null;

  return (
    <div className={`relative min-w-0 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={
          open && activeIndex >= 0
            ? `${menuId}-option-${activeIndex}`
            : undefined
        }
        disabled={disabled}
        onClick={() => {
          if (open) closeMenu();
          else openMenu();
        }}
        onKeyDown={handleKeyDown}
        className={`flex w-full items-center justify-between gap-3 border border-white/10 bg-black/25 text-left text-white outline-none transition-all hover:border-white/20 hover:bg-black/35 focus-visible:border-cyan-400/45 focus-visible:ring-2 focus-visible:ring-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-45 ${triggerSizes[size]} ${
          open ? "border-cyan-400/35 bg-black/40 ring-2 ring-cyan-400/10" : ""
        } ${triggerClassName}`}
      >
        <span
          className={`min-w-0 flex-1 truncate ${
            selectedOption ? "text-zinc-100" : "text-zinc-500"
          }`}
        >
          {selectedOption?.label || placeholder}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-150 ${
            open ? "rotate-180 text-zinc-300" : ""
          }`}
        />
      </button>
      {menu}
    </div>
  );
}
