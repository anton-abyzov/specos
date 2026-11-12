import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import fuzzysort from 'fuzzysort';
import { Glyph } from '../../design/icons';
import { projectName } from './format';
import { useProjects } from './projects';
import './picker.css';

export interface ProjectPickerHandle {
  open(): void;
}

interface ProjectPickerProps {
  /** A project path such as "Projects/notes", or null for a scratch workspace. */
  value: string | null;
  onChange(project: string | null): void;
  /** Which way the list opens from the chip. */
  placement: 'up' | 'down';
  /** Called when the list closes, so the caller can take the keyboard back. */
  onClose?(): void;
}

interface Option {
  path: string | null;
  name: string;
  note: string;
}

const NO_PROJECT: Option = { path: null, name: 'No project', note: 'an empty scratch workspace' };

/** The chip that says which project the next agent gets a copy of, and the list to change it. */
export const ProjectPicker = forwardRef<ProjectPickerHandle, ProjectPickerProps>(function ProjectPicker(
  { value, onChange, placement, onClose },
  ref,
) {
  const projects = useProjects((state) => state.projects);
  const refresh = useProjects((state) => state.refresh);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(refresh, [refresh]);

  const show = () => {
    refresh();
    setQuery('');
    setCursor(0);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  useImperativeHandle(ref, () => ({ open: show }));

  const options = useMemo<Option[]>(() => {
    const all = projects.map((project): Option => ({ path: project.path, name: project.name, note: project.path }));
    const text = query.trim();
    if (!text) return [NO_PROJECT, ...all];
    const found = fuzzysort.go(text, all, { key: 'name', threshold: 0 }).map((result) => result.obj);
    return 'no project scratch'.includes(text.toLowerCase()) ? [...found, NO_PROJECT] : found;
  }, [projects, query]);

  useLayoutEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  });

  const pick = (option: Option | undefined) => {
    if (!option) return;
    onChange(option.path);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The list owns its keys: nothing here should reach the composer's shortcuts.
    event.stopPropagation();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setCursor((index) => (options.length === 0 ? 0 : (index + step + options.length) % options.length));
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      pick(options[Math.min(cursor, options.length - 1)]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const active = Math.min(cursor, Math.max(0, options.length - 1));
  return (
    <div className="project-picker" ref={root} data-placement={placement}>
      <button
        type="button"
        className="project-picker__chip"
        data-testid="project-chip"
        data-empty={value === null || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Choose the project the agent gets a copy of"
        onClick={() => (open ? close() : show())}
      >
        <Glyph name={value === null ? 'file' : 'folder'} size={13} />
        <span className="project-picker__value">{value === null ? 'No project' : projectName(value)}</span>
        <Glyph name={placement === 'up' ? 'chevron-up' : 'chevron-down'} size={11} />
      </button>
      {open && (
        <div className="project-picker__panel" data-testid="project-picker">
          <input
            ref={input}
            className="project-picker__input"
            data-testid="project-picker-input"
            placeholder="Find a project"
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-label="Find a project"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
          />
          <ul className="project-picker__list" id={listId} role="listbox">
            {options.map((option, index) => (
              <li
                key={option.path ?? ''}
                role="option"
                className="project-picker__option"
                data-testid="project-option"
                data-active={index === active || undefined}
                aria-selected={option.path === value}
                onPointerMove={() => setCursor(index)}
                onClick={() => pick(option)}
              >
                <Glyph name={option.path === null ? 'file' : 'folder'} size={14} />
                <span className="project-picker__name">{option.name}</span>
                <span className="project-picker__note">{option.note}</span>
                {option.path === value && <Glyph name="check" size={13} />}
              </li>
            ))}
            {options.length === 0 && <li className="project-picker__none">No project matches “{query.trim()}”.</li>}
          </ul>
          {projects.length === 0 && <p className="project-picker__hint">Folders in Projects/ are listed here.</p>}
        </div>
      )}
    </div>
  );
});
