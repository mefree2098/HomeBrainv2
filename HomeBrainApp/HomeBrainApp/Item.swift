//
//  Item.swift
//  HomeBrainApp
//
//  Created by Matt Freestone on 2/26/26.
//

import Foundation
import SwiftData

@Model
final class Item {
    var timestamp: Date
    
    init(timestamp: Date) {
        self.timestamp = timestamp
    }
}
