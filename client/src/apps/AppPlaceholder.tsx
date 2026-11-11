import { APPS, type AppId } from './registry';
import { AppIcon } from '../design/icons';
import './app-placeholder.css';

/**
 * What an app window shows until the app itself is built: its icon, name and
 * the one line that says what it is for. Each app's index.tsx is replaced by
 * the real app; when the last one is, this file goes too.
 */
export function AppPlaceholder({ id }: { id: AppId }) {
  const app = APPS[id];
  return (
    <section className="app-placeholder" data-testid={`app-${id}`}>
      <AppIcon id={id} size={72} />
      <h1 className="app-placeholder__name">{app.name}</h1>
      <p className="app-placeholder__description">{app.description}</p>
    </section>
  );
}
