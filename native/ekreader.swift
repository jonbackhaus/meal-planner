// Native EventKit calendar reader (bead ob8).
// Args: <startISO> <endISO> [calendarName ...]  → JSON array of {calendarName,title,start,end,allDay,status} on stdout.
import EventKit
import Foundation
let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write(Data("usage: ekreader <startISO> <endISO> [name ...]\n".utf8)); exit(2) }
let inFmt = ISO8601DateFormatter()
guard let start = inFmt.date(from: args[1]), let end = inFmt.date(from: args[2]) else { FileHandle.standardError.write(Data("ekreader: bad ISO dates\n".utf8)); exit(2) }
let names = Array(args.dropFirst(3))
let store = EKEventStore()
let sema = DispatchSemaphore(value: 0)
var granted = false; var reqErr: Error?
store.requestFullAccessToEvents { ok, err in granted = ok; reqErr = err; sema.signal() }
sema.wait()
guard granted else { FileHandle.standardError.write(Data("ekreader: Calendars access denied\(reqErr.map { " (\($0))" } ?? "")\n".utf8)); exit(3) }
let allCals = store.calendars(for: .event)
let cals: [EKCalendar]
if names.isEmpty { cals = allCals } else { cals = allCals.filter { names.contains($0.title) }; if cals.isEmpty { print("[]"); exit(0) } }
let predicate = store.predicateForEvents(withStart: start, end: end, calendars: cals)
let events = store.events(matching: predicate)
let outFmt = ISO8601DateFormatter()
func statusStr(_ s: EKEventStatus) -> String { switch s { case .confirmed: return "confirmed"; case .tentative: return "tentative"; case .canceled: return "canceled"; default: return "confirmed" } }
let rows: [[String: Any]] = events.map { ev in ["calendarName": ev.calendar.title, "title": ev.title ?? "", "start": outFmt.string(from: ev.startDate), "end": outFmt.string(from: ev.endDate), "allDay": ev.isAllDay, "status": statusStr(ev.status)] }
let data = try JSONSerialization.data(withJSONObject: rows, options: [])
FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data("\n".utf8))
