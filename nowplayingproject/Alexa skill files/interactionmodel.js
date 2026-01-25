{
  "interactionModel": {
    "languageModel": {
      "invocationName": "mood audio",
      "intents": [
        {
          "name": "AMAZON.CancelIntent",
          "samples": []
        },
        {
          "name": "AMAZON.HelpIntent",
          "samples": []
        },
        {
          "name": "AMAZON.StopIntent",
          "samples": []
        },
        {
          "name": "AMAZON.FallbackIntent",
          "samples": []
        },
        {
          "name": "AMAZON.PauseIntent",
          "samples": []
        },
        {
          "name": "AMAZON.ResumeIntent",
          "samples": []
        },
        {
          "name": "AMAZON.NextIntent",
          "samples": []
        },
        {
          "name": "AMAZON.NavigateHomeIntent",
          "samples": []
        },
        {
          "name": "NowPlayingIntent",
          "slots": [],
          "samples": [
            "what's playing",
            "what is playing",
            "what song is this",
            "what track is this",
            "what's this",
            "what song is playing",
            "what track is playing",
            "name the song",
            "name the track",
            "who is this",
            "who is singing"
          ]
        },
        {
          "name": "PlayAlbumIntent",
          "slots": [
            {
              "name": "album",
              "type": "AMAZON.SearchQuery"
            }
          ],
          "samples": [
            "play album {album}",
            "play the album {album}",
            "start album {album}",
            "queue album {album}",
            "queue the album {album}",
            "play the album called {album}",
            "start the album called {album}"
          ]
        },
        {
          "name": "PlayPlaylistIntent",
          "slots": [
            {
              "name": "playlist",
              "type": "AMAZON.SearchQuery"
            }
          ],
          "samples": [
            "play playlist {playlist}",
            "play the playlist {playlist}",
            "start playlist {playlist}",
            "start the playlist {playlist}",
            "queue playlist {playlist}",
            "queue the playlist {playlist}",
            "play my playlist {playlist}",
            "start my playlist {playlist}",
            "play the playlist called {playlist}",
            "start the playlist called {playlist}"
          ]
        }
      ],
      "types": []
    }
  }
}