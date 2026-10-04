import useDownload from '../../../app/useDownload';
import { downloadProgressText } from '../../../app/downloadManager';
import { apiUrl } from '../../../utils/api';

export { downloadProgressText };

/**
 * Plain `<a href download>` in the browser build; in the app build the link carries no bearer token, so the click
 * downloads through useDownload and shows the progress instead of the children.
 */
export default function DownloadLink({ path, filename, children, ...props }) {
  const dl = useDownload(path);
  const onClick = (e) => {
    if (!dl.needed) return;
    e.preventDefault();
    if (!dl.busy) dl.start(path, { filename });
  };
  return (
    <a
      {...props}
      href={apiUrl(path)}
      onClick={onClick}
      aria-busy={dl.busy ? 'true' : undefined}
    >
      {dl.busy ? <span role="status">{downloadProgressText(dl.progress)}</span> : children}
    </a>
  );
}
