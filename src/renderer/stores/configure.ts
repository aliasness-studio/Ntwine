// Central MobX configuration. Each store module imports this file for its side effect
// (`import './configure';`) rather than calling `configure(...)` itself — one definition of the
// app's MobX settings, not three independently-maintained copies. The call below only actually
// EXECUTES once per module registry no matter how many files import it (ESM/CJS module caching
// dedupes by resolved path), so importing it from every store — including their test files,
// transitively — is safe, not a triple-configure.
//
// `enforceActions: 'observed'` requires every mutation of an OBSERVED observable (one a live
// reaction is currently reading) to happen inside a MobX action. The synchronous prefix of an
// `async` action method is covered automatically by `makeAutoObservable`'s action wrapping, but
// anything after the method's first `await` resumes OUTSIDE that transaction — those tail
// mutations must go through `runInAction` (or `flow`) explicitly, or MobX warns via
// `console.warn` the moment something is actually observing (e.g. a `mobx-react-lite` `observer`
// component).
import { configure } from 'mobx';

configure({ enforceActions: 'observed' });
