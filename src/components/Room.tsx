"use client";

import "@livekit/components-styles";
import {
  Chat,
  ControlBar,
  GridLayout,
  LayoutContextProvider,
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  useConnectionState,
  useCreateLayoutContext,
  useDataChannel,
  useLocalParticipant,
  useLocalParticipantPermissions,
  useParticipants,
  useRoomContext,
  useTracks,
} from "@livekit/components-react";
import { ConnectionState, DisconnectReason, RemoteTrackPublication, RoomEvent, Track, VideoQuality, type Participant } from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useMeetingEvents } from "@/lib/useMeetingEvents";
import { Badges } from "./Badges";
import { BreakoutsPanel } from "./BreakoutsPanel";
import { Captions } from "./Captions";
import type { DeviceChoices } from "./DevicePreview";
import { HostPanel } from "./HostPanel";
import { PollsPanel } from "./PollsPanel";
import { QAPanel } from "./QAPanel";
import { Whiteboard } from "./Whiteboard";

type DataMode = "normal" | "low" | "audio";
type Panel = "none" | "people" | "chat" | "qa" | "polls" | "board" | "breakouts" | "host";
const REACTIONS = ["👍", "👏", "❤️", "😂", "🙏", "🎉"];
const SCREEN_SHARE_SOURCE = 3; // protocol TrackSource enum

export interface RoomProps {
  code: string;
  meeting: any; // public meeting view
  viewer: { kind: string; key: string | null; moderator: boolean };
  token: string;
  serverUrl: string;
  role: string;
  breakoutId: string | null;
  choices: DeviceChoices;
  onLeave: (message: string) => void;
  /** Ask the parent to fetch a fresh token (e.g. breakout rooms opened/closed); it reconnects if the room changed. */
  onRefreshRoom: (visitBreakoutId?: string | null) => void;
  onMeetingChanged: () => void;
}

export default function Room(props: RoomProps) {
  const onDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      const msg =
        reason === DisconnectReason.PARTICIPANT_REMOVED
          ? "The host removed you from the meeting."
          : reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.ROOM_CLOSED
            ? "The meeting has ended."
            : reason === DisconnectReason.CLIENT_INITIATED
              ? "You left the meeting. You can rejoin without asking the host again."
              : reason === DisconnectReason.DUPLICATE_IDENTITY
                ? "You joined this meeting from another tab or device, so this one was disconnected."
                : "Your connection dropped and couldn't be restored. Check your network and rejoin. You won't need to be admitted again.";
      props.onLeave(msg);
    },
    [props],
  );

  return (
    <div className="room">
      <LiveKitRoom
        serverUrl={props.serverUrl}
        token={props.token}
        connect
        audio={props.choices.audio}
        video={props.choices.video}
        options={{ adaptiveStream: true, dynacast: true }}
        onDisconnected={onDisconnected}
        onError={(e) => {
          console.warn("[room]", e.message);
          props.onLeave(
            /full|max.?participants/i.test(e.message)
              ? "This meeting is full. Try again later or ask the host."
              : `Couldn't connect to the meeting: ${e.message}. Check your connection and try again.`,
          );
        }}
        data-lk-theme="default"
        style={{ display: "flex", flexDirection: "column", height: "100%" }}
      >
        <RoomInner {...props} />
        <RoomAudioRenderer />
      </LiveKitRoom>
    </div>
  );
}

function RoomInner({ code, meeting, viewer, role, breakoutId, onLeave, onRefreshRoom, onMeetingChanged }: RoomProps) {
  const room = useRoomContext();
  const layout = useCreateLayoutContext();
  const connection = useConnectionState();
  const perms = useLocalParticipantPermissions();
  const { isMicrophoneEnabled } = useLocalParticipant();
  const participants = useParticipants();
  const moderator = viewer.moderator || role === "host" || role === "cohost";
  const [panel, setPanel] = useState<Panel>(moderator && typeof window !== "undefined" && window.innerWidth > 760 ? "host" : "none");
  const [dataMode, setDataMode] = useState<DataMode>("normal");
  const [floating, setFloating] = useState<Array<{ id: number; emoji: string }>>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [versions, setVersions] = useState({ qa: 0, polls: 0, requests: 0, breakouts: 0 });
  const [unread, setUnread] = useState<Partial<Record<Panel, boolean>>>({});
  const [waiting, setWaiting] = useState(0);
  const [safetyAlert, setSafetyAlert] = useState<string | null>(null);
  const [showCaptions, setShowCaptions] = useState(true);
  const [recordingAck, setRecordingAck] = useState(false);
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([]);
  const [reportTarget, setReportTarget] = useState<{ id: string | null; name: string } | null>(null);
  const bus = useRef(new EventTarget()).current;

  const bump = (k: keyof typeof versions, p?: Panel) => {
    setVersions((v) => ({ ...v, [k]: v[k] + 1 }));
    if (p) setUnread((u) => (panel === p ? u : { ...u, [p]: true }));
  };
  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 6000);
  };

  // One event stream for the whole room; panels get version bumps or bus events.
  useMeetingEvents(
    code,
    {
      qa_changed: () => bump("qa", "qa"),
      polls_changed: () => bump("polls", "polls"),
      requests_changed: () => bump("requests"),
      presence: () => bump("requests"),
      hand: () => bump("requests"),
      breakouts_changed: () => {
        bump("breakouts");
        onRefreshRoom();
      },
      broadcast_message: (d) => flash(`📣 ${d.from}: ${d.message}`),
      settings_changed: () => onMeetingChanged(),
      recording_changed: () => onMeetingChanged(),
      stream_changed: () => onMeetingChanged(),
      transcription_changed: () => onMeetingChanged(),
      meeting_ended: () => onLeave("The host ended the meeting."),
      safety_alert: (d) => setSafetyAlert(d.code === "join_burst" ? `Unusual burst of ${d.count} join requests.` : "A participant reported abuse."),
      caption: (d) => bus.dispatchEvent(new CustomEvent("caption", { detail: d })),
      wb_stroke: (d) => bus.dispatchEvent(new CustomEvent("wb_stroke", { detail: d })),
      wb_clear: () => bus.dispatchEvent(new CustomEvent("wb_clear")),
    },
    { onReconnect: () => setVersions((v) => ({ qa: v.qa + 1, polls: v.polls + 1, requests: v.requests + 1, breakouts: v.breakouts + 1 })) },
  );

  // Waiting count for the host button (from the host's own listing).
  useEffect(() => {
    if (!moderator) return;
    api(`/api/meetings/${code}/requests`)
      .then((r) => setWaiting(r.requests.filter((x: { status: string }) => x.status === "pending").length))
      .catch(() => {});
  }, [code, moderator, versions.requests]);

  const canPublish = !!perms?.canPublish;
  const sources = perms?.canPublishSources ?? [];
  const canScreenShare = canPublish && (sources.length === 0 || sources.includes(SCREEN_SHARE_SOURCE));
  const canData = perms?.canPublishData ?? false;

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  // In presentation mode, show only people who can publish (speakers), not every audience member.
  const visible = useMemo(
    () => tracks.filter((t) => meeting.mode !== "broadcast" || t.participant.permissions?.canPublish !== false || t.publication),
    [tracks, meeting.mode],
  );

  const { send } = useDataChannel("reaction", (msg) => {
    const emoji = new TextDecoder().decode(msg.payload);
    if (REACTIONS.includes(emoji)) pushReaction(emoji);
  });
  function pushReaction(emoji: string) {
    const id = Date.now() + Math.random();
    setFloating((f) => [...f.slice(-6), { id, emoji }]);
    setTimeout(() => setFloating((f) => f.filter((x) => x.id !== id)), 3000);
  }
  function react(emoji: string) {
    send(new TextEncoder().encode(emoji), { reliable: false });
    pushReaction(emoji);
  }

  // Low-data modes: lower or pause incoming video, and stop sending camera.
  useEffect(() => {
    const apply = () => {
      room.remoteParticipants.forEach((p) =>
        p.trackPublications.forEach((pub) => {
          if (!(pub instanceof RemoteTrackPublication) || pub.kind !== Track.Kind.Video) return;
          const isScreen = pub.source === Track.Source.ScreenShare;
          pub.setEnabled(dataMode !== "audio" || isScreen);
          pub.setVideoQuality(dataMode === "low" ? VideoQuality.LOW : VideoQuality.HIGH);
        }),
      );
    };
    apply();
    if (dataMode !== "normal") room.localParticipant.setCameraEnabled(false).catch(() => {});
    room.on(RoomEvent.TrackPublished, apply).on(RoomEvent.TrackSubscribed, apply);
    return () => {
      room.off(RoomEvent.TrackPublished, apply).off(RoomEvent.TrackSubscribed, apply);
    };
  }, [dataMode, room]);

  const myHand = !!room.localParticipant.attributes?.hand;
  async function toggleHand() {
    try {
      await api(`/api/meetings/${code}/hand`, { body: { raised: !myHand } });
    } catch (err) {
      setNotice((err as Error).message);
    }
  }

  const recordingOn = meeting.recordingActive;
  useEffect(() => {
    if (!recordingOn) setRecordingAck(false);
  }, [recordingOn]);

  const open = (p: Panel) => {
    setPanel(panel === p ? "none" : p);
    setUnread((u) => ({ ...u, [p]: false }));
  };
  const raisedHands = participants.filter((p) => p.attributes?.hand);
  const f = meeting.features ?? {};
  const tabs: Array<[Panel, string, boolean]> = [
    ["people", `People ${participants.length}${raisedHands.length ? ` ✋${raisedHands.length}` : ""}`, true],
    ["chat", "Chat", canData],
    ["qa", "Q&A", !!f.qa],
    ["polls", "Polls", !!f.polls],
    ["board", "Board", !!f.whiteboard],
    ["breakouts", "Rooms", moderator || meeting.breakoutsOpen],
    ["host", `Host${waiting ? ` · ${waiting} waiting` : ""}`, moderator],
  ];

  return (
    <LayoutContextProvider value={layout}>
      {connection === ConnectionState.Reconnecting && (
        <div className="banner warn" role="status">Connection unstable, reconnecting… Your place in the meeting is kept.</div>
      )}
      {connection === ConnectionState.Connecting && <div className="banner warn" role="status">Connecting…</div>}
      {recordingOn && (
        <div className="banner bad" role="status"><span className="rec-dot" aria-hidden />This meeting is being recorded</div>
      )}
      {meeting.streamActive && <div className="banner warn" role="status">🔴 Live: this meeting is being streamed to an audience</div>}
      {breakoutId && <div className="banner warn" role="status">You're in a breakout room</div>}
      <div className="room-top">
        <div className="room-title" title={meeting.title}>{meeting.title}</div>
        <div className="row">
          <label className="sr-only" htmlFor="datamode">Data usage</label>
          <select
            id="datamode"
            value={dataMode}
            onChange={(e) => setDataMode(e.target.value as DataMode)}
            style={{ width: "auto", minHeight: 36, padding: "4px 8px", background: "#232a38", color: "#e8ebf1", borderColor: "#36405a" }}
          >
            <option value="normal">Normal video</option>
            <option value="low">Low data</option>
            <option value="audio">Audio only</option>
          </select>
          {!moderator && (
            <button className="small" onClick={toggleHand} aria-pressed={myHand}>✋ <span className="hide-mobile">{myHand ? "Lower" : "Raise"}</span></button>
          )}
          {meeting.transcriptionActive && (
            <button className="small" aria-pressed={showCaptions} onClick={() => setShowCaptions(!showCaptions)} aria-label="Toggle captions">CC</button>
          )}
          {tabs.filter(([, , show]) => show).map(([id, label]) => (
            <button key={id} className="small" aria-pressed={panel === id} onClick={() => open(id)}>
              {label}{unread[id] ? " •" : ""}
            </button>
          ))}
        </div>
      </div>
      {notice && <div className="banner warn" role="alert" onClick={() => setNotice(null)}>{notice}</div>}
      {toast && <div className="toast" role="status">{toast}</div>}
      <div className="room-body">
        <div className="room-stage" style={{ position: "relative" }}>
          {visible.length > 0 ? (
            <GridLayout tracks={visible}>
              <ParticipantTile />
            </GridLayout>
          ) : (
            <div style={{ flex: 1, display: "grid", placeItems: "center" }} className="muted">Waiting for the presenter…</div>
          )}
          <Captions code={code} active={meeting.transcriptionActive} micOn={isMicrophoneEnabled} show={showCaptions} bus={bus} />
          <div className="reactions" aria-hidden>
            {floating.map((r) => <span key={r.id} className="reaction">{r.emoji}</span>)}
          </div>
          <div className="row" style={{ justifyContent: "center", padding: "4px 8px" }}>
            {canData && REACTIONS.map((e) => (
              <button key={e} className="small" onClick={() => react(e)} aria-label={`React ${e}`}>{e}</button>
            ))}
          </div>
          <ControlBar
            variation="minimal"
            controls={{ microphone: canPublish, camera: canPublish && dataMode === "normal", screenShare: canScreenShare, chat: false, leave: true }}
          />
        </div>
        {panel !== "none" && (
          <aside className="room-side" aria-label="Side panel">
            <div className="row spread" style={{ padding: "8px 12px" }}>
              <strong>{tabs.find(([id]) => id === panel)?.[1].split(" ·")[0]}</strong>
              <button className="small" onClick={() => setPanel("none")} aria-label="Close panel">✕</button>
            </div>
            <div className="room-side-body">
              {panel === "people" && <PeopleList participants={participants} onReport={(p) => setReportTarget(p)} />}
              {panel === "chat" && canData && <Chat style={{ height: "100%" }} />}
              {panel === "qa" && <QAPanel code={code} moderator={moderator} version={versions.qa} allowAnonymous={!!f.qaAnonymous} moderated={!!f.qaModerated} />}
              {panel === "polls" && <PollsPanel code={code} moderator={moderator} version={versions.polls} />}
              {panel === "board" && <Whiteboard code={code} moderator={moderator} enabled={!!f.whiteboard} bus={bus} myKey={viewer.key} />}
              {panel === "breakouts" && (
                <BreakoutsPanel code={code} moderator={moderator} version={versions.breakouts} people={people} currentBreakoutId={breakoutId} onVisit={(id) => onRefreshRoom(id)} />
              )}
              {panel === "host" && moderator && (
                <HostPanel code={code} participants={participants} version={versions.requests} isHost={role === "host"} safetyAlert={safetyAlert} onPeople={setPeople} />
              )}
            </div>
          </aside>
        )}
        {/* Keep the people list fresh for breakout assignment even when the host panel is closed. */}
        {moderator && panel !== "host" && (
          <div hidden>
            <HostPanel code={code} participants={participants} version={versions.requests} isHost={role === "host"} safetyAlert={null} onPeople={setPeople} />
          </div>
        )}
      </div>

      {recordingOn && !recordingAck && !moderator && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rec-title">
          <div className="modal stack">
            <h2 id="rec-title"><span className="rec-dot" aria-hidden />This meeting is being recorded</h2>
            <p>The host started recording. Your audio, video and screen share will be in the recording if you stay. You can turn your camera off or leave.</p>
            <div className="row">
              <button
                className="primary"
                onClick={() => {
                  setRecordingAck(true);
                  api(`/api/meetings/${code}/consent`, { body: { kind: "recording", granted: true } }).catch(() => {});
                }}
              >
                Continue
              </button>
              <button
                onClick={() => {
                  api(`/api/meetings/${code}/consent`, { body: { kind: "recording", granted: false } }).catch(() => {});
                  room.disconnect();
                }}
              >
                Leave meeting
              </button>
            </div>
          </div>
        </div>
      )}
      {reportTarget && <ReportDialog code={code} target={reportTarget} onClose={() => setReportTarget(null)} />}
    </LayoutContextProvider>
  );
}

function readBadges(p: Participant): string[] {
  try {
    const meta = JSON.parse(p.metadata ?? "{}");
    return Array.isArray(meta.badges) ? meta.badges : [];
  } catch {
    return [];
  }
}

function PeopleList({ participants, onReport }: { participants: Participant[]; onReport: (p: { id: string | null; name: string }) => void }) {
  const sorted = [...participants].sort((a, b) => Number(b.attributes?.hand || 0) - Number(a.attributes?.hand || 0));
  return (
    <div className="stack">
      <ul className="list">
        {sorted.map((p) => (
          <li key={p.identity} className="stack" style={{ gap: 4 }}>
            <div className="row spread">
              <span>
                {p.attributes?.hand ? <span className="hand" aria-label="Hand raised">✋ </span> : null}
                {p.name || "Guest"} {p.isLocal ? <span className="muted small">(you)</span> : null}
              </span>
              <span className="row" style={{ gap: 4 }}>
                <span className="small muted">{p.isMicrophoneEnabled ? "🎙" : "🔇"}</span>
                {!p.isLocal && (
                  <button className="small" onClick={() => onReport({ id: p.identity.startsWith("jr:") ? p.identity.slice(3) : null, name: p.name || "Guest" })} aria-label={`Report ${p.name}`}>
                    ⚑
                  </button>
                )}
              </span>
            </div>
            <Badges badges={readBadges(p)} />
          </li>
        ))}
      </ul>
      <button className="small" onClick={() => onReport({ id: null, name: "this meeting" })}>Report a problem</button>
    </div>
  );
}

function ReportDialog({ code, target, onClose }: { code: string; target: { id: string | null; name: string }; onClose: () => void }) {
  const [reason, setReason] = useState("harassment");
  const [details, setDetails] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api(`/api/meetings/${code}/report`, { body: { targetRequestId: target.id, reason, details: details || undefined } });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="report-title">
      <form className="modal stack" onSubmit={submit}>
        <h2 id="report-title">Report {target.name}</h2>
        {done ? (
          <p>Thanks. The host and the MeetSphere safety team have been notified.</p>
        ) : (
          <>
            <label htmlFor="reason">What's wrong?</label>
            <select id="reason" value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="harassment">Harassment or bullying</option>
              <option value="spam">Spam</option>
              <option value="inappropriate_content">Inappropriate content</option>
              <option value="impersonation">Pretending to be someone else</option>
              <option value="other">Something else</option>
            </select>
            <label htmlFor="details">Details (optional)</label>
            <textarea id="details" rows={3} maxLength={2000} value={details} onChange={(e) => setDetails(e.target.value)} />
            {error && <div className="alert error">{error}</div>}
          </>
        )}
        <div className="row">
          {!done && <button className="primary" type="submit">Send report</button>}
          <button type="button" onClick={onClose}>{done ? "Close" : "Cancel"}</button>
        </div>
      </form>
    </div>
  );
}
