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
  useLocalParticipantPermissions,
  useParticipants,
  useRoomContext,
  useTracks,
} from "@livekit/components-react";
import {
  ConnectionState,
  DisconnectReason,
  RemoteTrackPublication,
  RoomEvent,
  Track,
  VideoQuality,
  type Participant,
} from "livekit-client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badges } from "./Badges";
import { HostPanel } from "./HostPanel";
import { api } from "@/lib/client";
import type { DeviceChoices } from "./DevicePreview";

type DataMode = "normal" | "low" | "audio";
type Panel = "none" | "people" | "chat" | "host";
const REACTIONS = ["👍", "👏", "❤️", "😂", "🙏", "🎉"];
// Protocol TrackSource enum value for screen share.
const SCREEN_SHARE_SOURCE = 3;

interface Props {
  code: string;
  title: string;
  token: string;
  serverUrl: string;
  role: string;
  choices: DeviceChoices;
  onLeave: (message: string) => void;
}

export default function Room(props: Props) {
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

function RoomInner({ code, title, role }: Props) {
  const room = useRoomContext();
  const layout = useCreateLayoutContext();
  const connection = useConnectionState();
  const perms = useLocalParticipantPermissions();
  const participants = useParticipants();
  const isHost = role === "host" || role === "cohost";
  // On phones the side panel covers the video, so only open host controls by default on wide screens.
  const [panel, setPanel] = useState<Panel>(isHost && typeof window !== "undefined" && window.innerWidth > 760 ? "host" : "none");
  const waiting = useWaitingCount(code, isHost);
  const [dataMode, setDataMode] = useState<DataMode>("normal");
  const [floating, setFloating] = useState<Array<{ id: number; emoji: string }>>([]);
  const [handBusy, setHandBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
  // In presentation mode, only show people who can publish (speakers), not the whole audience.
  const visible = useMemo(
    () => tracks.filter((t) => t.participant.permissions?.canPublish !== false || t.publication),
    [tracks],
  );

  // Reactions over the data channel (only when the host allows chat/data).
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
          if (dataMode === "low") pub.setVideoQuality(VideoQuality.LOW);
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
    setHandBusy(true);
    try {
      await api(`/api/meetings/${code}/hand`, { body: { raised: !myHand } });
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setHandBusy(false);
    }
  }

  const raisedHands = participants.filter((p) => p.attributes?.hand);

  return (
    <LayoutContextProvider value={layout}>
      {connection === ConnectionState.Reconnecting && (
        <div className="banner warn" role="status">Connection unstable, reconnecting… Your place in the meeting is kept.</div>
      )}
      {connection === ConnectionState.Connecting && <div className="banner warn" role="status">Connecting…</div>}
      <div className="room-top">
        <div className="room-title" title={title}>{title}</div>
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
          {!isHost && (
            <button className="small" onClick={toggleHand} disabled={handBusy} aria-pressed={myHand}>
              ✋ <span className="hide-mobile">{myHand ? "Lower hand" : "Raise hand"}</span>
            </button>
          )}
          <button className="small" aria-pressed={panel === "people"} onClick={() => setPanel(panel === "people" ? "none" : "people")}>
            People ({participants.length}){raisedHands.length ? ` ✋${raisedHands.length}` : ""}
          </button>
          {canData && (
            <button className="small" aria-pressed={panel === "chat"} onClick={() => setPanel(panel === "chat" ? "none" : "chat")}>Chat</button>
          )}
          {isHost && (
            <button className="small" aria-pressed={panel === "host"} onClick={() => setPanel(panel === "host" ? "none" : "host")}>
              Host{waiting > 0 ? ` · ${waiting} waiting` : ""}
            </button>
          )}
        </div>
      </div>
      {notice && (
        <div className="banner warn" role="alert" onClick={() => setNotice(null)}>{notice}</div>
      )}
      <div className="room-body">
        <div className="room-stage" style={{ position: "relative" }}>
          {visible.length > 0 ? (
            <GridLayout tracks={visible}>
              <ParticipantTile />
            </GridLayout>
          ) : (
            <div style={{ flex: 1, display: "grid", placeItems: "center" }} className="muted">Waiting for the presenter…</div>
          )}
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
              <strong>{panel === "people" ? "People" : panel === "chat" ? "Chat" : "Host controls"}</strong>
              <button className="small" onClick={() => setPanel("none")} aria-label="Close panel">✕</button>
            </div>
            <div className="room-side-body">
              {panel === "people" && <PeopleList participants={participants} />}
              {panel === "chat" && canData && <Chat style={{ height: "100%" }} />}
              {panel === "host" && isHost && <HostPanel code={code} participants={participants} />}
            </div>
          </aside>
        )}
      </div>
    </LayoutContextProvider>
  );
}

/** Lightweight poll so hosts notice people waiting even with the panel closed. */
function useWaitingCount(code: string, enabled: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = () =>
      api(`/api/meetings/${code}/requests`)
        .then((r) => alive && setN(r.requests.filter((x: { status: string }) => x.status === "pending").length))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code, enabled]);
  return n;
}

function readBadges(p: Participant): string[] {
  try {
    const meta = JSON.parse(p.metadata ?? "{}");
    return Array.isArray(meta.badges) ? meta.badges : [];
  } catch {
    return [];
  }
}

function PeopleList({ participants }: { participants: Participant[] }) {
  const sorted = [...participants].sort((a, b) => Number(b.attributes?.hand || 0) - Number(a.attributes?.hand || 0));
  return (
    <ul className="list">
      {sorted.map((p) => (
        <li key={p.identity} className="stack" style={{ gap: 4 }}>
          <div className="row spread">
            <span>
              {p.attributes?.hand ? <span className="hand" aria-label="Hand raised">✋ </span> : null}
              {p.name || "Guest"} {p.isLocal ? <span className="muted small">(you)</span> : null}
            </span>
            <span className="small muted">{p.isMicrophoneEnabled ? "🎙" : "🔇"}</span>
          </div>
          <Badges badges={readBadges(p)} />
        </li>
      ))}
    </ul>
  );
}
