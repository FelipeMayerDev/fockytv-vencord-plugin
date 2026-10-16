// SPDX-License-Identifier: GPL-3.0-or-later
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

// As taxas usam o relógio do relatório; trocar a faixa reinicia a comparação.
function delta(current: any, previous: any, key: string) {
    const timestamp = number(current?.timestamp), beforeTimestamp = number(previous?.timestamp);
    if (timestamp === null || beforeTimestamp === null || timestamp <= beforeTimestamp || current.id !== previous.id || current.ssrc !== previous.ssrc) return null;
    const now = number(current[key]), before = number(previous[key]);
    return now !== null && before !== null && now >= before ? now - before : null;
}

function rate(current: any, previous: any, key: string) {
    const change = delta(current, previous, key);
    return change === null ? null : change * 1000 / (current.timestamp - previous.timestamp);
}

export function videoStats(report: RTCStatsReport, previous?: RTCStatsReport) {
    return [...report.values()].filter(row =>
        ["outbound-rtp", "inbound-rtp"].includes(row.type) && (row.kind ?? row.mediaType) === "video" && !row.isRemote &&
        !/^video\/(rtx|red|ulpfec|flexfec-03)$/i.test(report.get(row.codecId)?.mimeType ?? "")
    ).map(row => {
        const before = previous?.get(row.id);
        const source = report.get(row.mediaSourceId), previousSource = previous?.get(row.mediaSourceId);
        const sending = row.type === "outbound-rtp";
        const frames = delta(row, before, sending ? "framesEncoded" : "framesDecoded");
        const time = delta(row, before, sending ? "totalEncodeTime" : "totalDecodeTime");
        const lost = delta(row, before, "packetsLost"), received = delta(row, before, "packetsReceived");
        const emitted = delta(row, before, "jitterBufferEmittedCount"), delay = delta(row, before, "jitterBufferDelay");
        const sendDelay = delta(row, before, "totalPacketSendDelay"), sent = delta(row, before, "packetsSent");
        const pair = report.get(report.get(row.transportId)?.selectedCandidatePairId);
        const remote = report.get(row.remoteId);
        const rtt = number(pair?.currentRoundTripTime ?? remote?.roundTripTime);
        const bitrate = rate(row, before, sending ? "bytesSent" : "bytesReceived");
        return {
            direction: sending ? "send" : "receive",
            statsTimestamp: number(row.timestamp),
            width: number(row.frameWidth), height: number(row.frameHeight),
            captureFps: sending ? rate(source, previousSource, "frames") ?? number(source?.framesPerSecond) : null,
            encodedFps: sending ? rate(row, before, "framesEncoded") ?? number(row.framesPerSecond) : null,
            sentFps: sending ? rate(row, before, "framesSent") : null,
            receivedFps: sending ? null : rate(row, before, "framesReceived"),
            decodedFps: sending ? null : rate(row, before, "framesDecoded") ?? number(row.framesPerSecond),
            mbps: bitrate === null ? null : bitrate * 8 / 1_000_000,
            processingMs: frames !== null && frames > 0 && time !== null ? time * 1000 / frames : null,
            encoder: sending ? row.encoderImplementation ?? null : null,
            powerEfficientEncoder: sending ? row.powerEfficientEncoder ?? null : null,
            limitation: sending ? row.qualityLimitationReason ?? null : null,
            codec: report.get(row.codecId)?.mimeType ?? null,
            lossPercent: lost !== null && received !== null && lost + received > 0 ? lost * 100 / (lost + received) : null,
            receiverReportedPacketsLost: sending ? number(remote?.packetsLost) : null,
            rttMs: rtt === null ? null : rtt * 1000,
            sendDelayMs: sent !== null && sent > 0 && sendDelay !== null ? sendDelay * 1000 / sent : null,
            jitterBufferMs: emitted !== null && emitted > 0 && delay !== null ? delay * 1000 / emitted : null,
            droppedFrames: delta(row, before, "framesDropped"),
            freezes: delta(row, before, "freezeCount"),
            freezeSeconds: delta(row, before, "totalFreezesDuration"),
            keyFrames: delta(row, before, sending ? "keyFramesEncoded" : "keyFramesDecoded"),
            nacks: delta(row, before, "nackCount"),
            plis: delta(row, before, "pliCount")
        };
    });
}
