export function BoardroomHelp() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="max-w-2xl space-y-4">
        <h3 className="font-serif text-2xl font-bold">Where to get help</h3>
        <div className="border border-stone-300 bg-white p-4">
          <h4 className="font-semibold">Inside the Boardroom</h4>
          <p className="mt-2 text-sm leading-relaxed text-stone-600">You can revisit a conversation, continue a discussion, work from an advisor card, upload a document, or update your profile here. If a conversation or upload fails, send us the error you saw and what you were doing.</p>
        </div>
        <div className="border border-stone-300 bg-white p-4">
          <h4 className="font-semibold">Account, access, or billing</h4>
          <p className="mt-2 text-sm leading-relaxed text-stone-600">Those are managed by the main Studio, not inside this Boardroom workspace. Return to Studio for your account and product access, or contact David if something does not look right.</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <a className="border border-teal px-3 py-2 text-sm font-semibold text-teal hover:bg-teal hover:text-white" href="/">Go to Studio</a>
            <a className="border border-stone-300 px-3 py-2 text-sm font-semibold hover:border-teal" href="mailto:contact@davidbee.me?subject=AI%20Boardroom%20help">Contact David for help</a>
          </div>
        </div>
      </div>
    </div>
  );
}
