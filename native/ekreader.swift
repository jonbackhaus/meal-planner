// Native EventKit calendar reader (bead ob8).
// Args: <startISO> <endISO> [calendarName ...]  → JSON array of {calendarName,title,start,end,allDay,status} on stdout.
import EventKit
import Foundation

let args = CommandLine.arguments
guard args.count >= 3 else {
  FileHandle.standardError.write(Data("usage: ekreader <startISO> <endISO> [name ...]\n".utf8))
  exit(2)
}

// The daemon passes Date.toISOString() which INCLUDES milliseconds
// ("2026-07-25T11:45:47.036Z"); a bare ISO8601DateFormatter rejects fractional
// seconds. Parse with fractional seconds first, then fall back to without, so
// both shapes work (bug found during the ob8 launchd investigation).
func parseISO(_ s: String) -> Date? {
  let withFrac = ISO8601DateFormatter()
  withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let d = withFrac.date(from: s) { return d }
  let plain = ISO8601DateFormatter()
  plain.formatOptions = [.withInternetDateTime]
  return plain.date(from: s)
}

guard let start = parseISO(args[1]), let end = parseISO(args[2]) else {
  FileHandle.standardError.write(Data("ekreader: bad ISO dates\n".utf8))
  exit(2)
}

let names = Array(args.dropFirst(3))
let store = EKEventStore()
let sema = DispatchSemaphore(value: 0)
var granted = false
var reqErr: Error?
store.requestFullAccessToEvents { ok, err in
  granted = ok
  reqErr = err
  sema.signal()
}
sema.wait()
guard granted else {
  FileHandle.standardError.write(Data("ekreader: Calendars access denied\(reqErr.map { " (\($0))" } ?? "")\n".utf8))
  exit(3)
}

let allCals = store.calendars(for: .event)
let cals: [EKCalendar]
if names.isEmpty {
  cals = allCals
} else {
  cals = allCals.filter { names.contains($0.title) }
  if cals.isEmpty {
    print("[]")
    exit(0)
  }
}

let predicate = store.predicateForEvents(withStart: start, end: end, calendars: cals)
let events = store.events(matching: predicate)
let outFmt = ISO8601DateFormatter()
outFmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

func statusStr(_ s: EKEventStatus) -> String {
  switch s {
  case .confirmed: return "confirmed"
  case .tentative: return "tentative"
  case .canceled: return "canceled"
  default: return "confirmed"
  }
}

let rows: [[String: Any]] = events.map { ev in
  [
    "calendarName": ev.calendar.title,
    "title": ev.title ?? "",
    "start": outFmt.string(from: ev.startDate),
    "end": outFmt.string(from: ev.endDate),
    "allDay": ev.isAllDay,
    "status": statusStr(ev.status),
  ]
}
let data = try JSONSerialization.data(withJSONObject: rows, options: [])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
