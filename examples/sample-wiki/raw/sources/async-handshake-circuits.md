---
title: Asynchronous Handshake Circuits
domain: hardware/async-circuits
source_kind: article
---
# Asynchronous Handshake Circuits

Most digital chips use a global clock. The clock is a steady pulse that tells every part of the chip when to read its inputs and when to store its results. Asynchronous circuits do without it. Instead, each part tells its neighbor when data is ready, and the neighbor says when it has taken the data.

## The handshake

Two neighboring stages talk through a pair of wires, usually called request and acknowledge. The sender puts data on its output lines and raises the request wire. The receiver sees the request, takes the data, and raises the acknowledge wire. The sender then lowers the request, and the receiver lowers the acknowledge. Now both sides are ready for the next item. Each step waits for the step before it, so no stage needs to know how long another stage takes.

A chain of such stages forms a pipeline. Data moves forward when the next stage is free. The pipeline follows the actual delay of each stage, not a worst-case budget that a clock period would fix in advance.

## Energy

A clocked chip sends the clock signal to every register on every cycle, even when little is changing. This costs energy. An asynchronous circuit is event-driven: a part switches only when data arrives for it. When the inputs are quiet, almost nothing toggles, so the circuit uses very little dynamic power. This helps most in devices that are idle for long periods, such as small sensors.

## Other properties

Without a clock, there is no clock distribution network to design, and there is no clock skew.

## Difficulties

The main drawback is verification. A synchronous design can be checked one clock cycle at a time, and mature tools exist for this work. An asynchronous design has no such cycle boundary. Engineers must show that every handshake finishes in the right order under all combinations of delay. A hazard, such as a brief false pulse on a wire, can corrupt a handshake and stall the circuit. Design tools for these circuits are less common than tools for clocked circuits, and few engineers have trained in this style.

For these reasons, asynchronous techniques are mostly used in small blocks, such as the interface between two parts of a chip that run on different clocks, and in a limited number of research and special-purpose chips.
